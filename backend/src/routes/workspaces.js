import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import Workspace from '../models/Workspace.js';
import Project from '../models/Project.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import Invitation from '../models/Invitation.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { loadWorkspace, roleOf } from '../services/access.js';
import { notify } from '../services/notify.js';
import { config } from '../config.js';
import { removeStoredFiles } from '../services/files.js';

const router = Router();
router.use(requireAuth);

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function present(workspace, userId) {
  await workspace.populate('members.user', 'name email');
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    owner: String(workspace.owner),
    myRole: roleOf(workspace, userId),
    createdAt: workspace.createdAt,
    members: workspace.members.filter((m) => m.user).map((m) => ({
      userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role, joinedAt: m.joinedAt
    }))
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await Workspace.find({ 'members.user': req.user.id }).sort({ createdAt: 1 });
  res.json({ workspaces: await Promise.all(list.map((w) => present(w, req.user.id))) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = parse(z.object({
    name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).optional().default('')
  }), req.body);
  const workspace = await Workspace.create({ ...data, owner: req.user.id, members: [{ user: req.user.id, role: 'owner' }] });
  res.status(201).json({ workspace: await present(workspace, req.user.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { workspace } = await loadWorkspace(requireId(req.params.id), req.user.id);
  res.json({ workspace: await present(workspace, req.user.id) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { workspace } = await loadWorkspace(requireId(req.params.id), req.user.id, 'admin');
  const data = parse(z.object({
    name: z.string().trim().min(2).max(100).optional(), description: z.string().trim().max(500).optional()
  }), req.body);
  Object.assign(workspace, data);
  await workspace.save();
  res.json({ workspace: await present(workspace, req.user.id) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { workspace } = await loadWorkspace(requireId(req.params.id), req.user.id, 'owner');
  const tasks = await Task.find({ workspace: workspace._id }).select('attachments');
  await Promise.all(tasks.map((t) => removeStoredFiles(t.attachments)));
  await Promise.all([
    Task.deleteMany({ workspace: workspace._id }),
    Project.deleteMany({ workspace: workspace._id }),
    Invitation.deleteMany({ workspace: workspace._id }),
    workspace.deleteOne()
  ]);
  res.json({ ok: true });
}));

/* ---- Members ---- */
router.patch('/:id/members/:userId', asyncHandler(async (req, res) => {
  const { workspace, role: myRole } = await loadWorkspace(requireId(req.params.id), req.user.id, 'admin');
  const { role } = parse(z.object({ role: z.enum(['admin', 'member', 'viewer']) }), req.body);
  const member = workspace.members.find((m) => String(m.user) === req.params.userId);
  if (!member) throw new HttpError(404, 'Member not found');
  if (member.role === 'owner') throw new HttpError(400, 'The workspace owner role cannot be changed');
  if (myRole !== 'owner' && (role === 'admin' || member.role === 'admin')) {
    throw new HttpError(403, 'Only the owner can grant or change admin access');
  }
  member.role = role;
  await workspace.save();
  await notify(member.user, { actor: req.user.id, type: 'role_changed', title: 'Your role changed', message: `You are now ${role} in ${workspace.name}.`, link: '/team' });
  res.json({ workspace: await present(workspace, req.user.id) });
}));

router.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
  const { workspace, role: myRole } = await loadWorkspace(requireId(req.params.id), req.user.id);
  const target = workspace.members.find((m) => String(m.user) === req.params.userId);
  if (!target) throw new HttpError(404, 'Member not found');
  const leaving = req.params.userId === req.user.id;
  if (target.role === 'owner') throw new HttpError(400, 'The owner cannot leave or be removed. Delete the workspace instead.');
  if (!leaving) {
    if (myRole !== 'owner' && myRole !== 'admin') throw new HttpError(403, 'Admin access required');
    if (myRole === 'admin' && target.role === 'admin') throw new HttpError(403, 'Only the owner can remove an admin');
  }
  workspace.members = workspace.members.filter((m) => String(m.user) !== req.params.userId);
  await workspace.save();
  await Task.updateMany({ workspace: workspace._id, assignee: req.params.userId }, { $set: { assignee: null } });
  if (!leaving) await notify(req.params.userId, { actor: req.user.id, type: 'removed', title: 'Removed from workspace', message: `You were removed from ${workspace.name}.` });
  res.json({ ok: true });
}));

/* ---- Invitations (admin side) ---- */
router.get('/:id/invitations', asyncHandler(async (req, res) => {
  const { workspace } = await loadWorkspace(requireId(req.params.id), req.user.id, 'admin');
  const invitations = await Invitation.find({ workspace: workspace._id, status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  res.json({ invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt })) });
}));

router.post('/:id/invitations', asyncHandler(async (req, res) => {
  const { workspace, role: myRole } = await loadWorkspace(requireId(req.params.id), req.user.id, 'admin');
  const data = parse(z.object({
    email: z.string().trim().email().max(254), role: z.enum(['admin', 'member', 'viewer']).default('member')
  }), req.body);
  if (data.role === 'admin' && myRole !== 'owner') throw new HttpError(403, 'Only the owner can invite admins');
  const email = data.email.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing && workspace.members.some((m) => String(m.user) === existing.id)) {
    throw new HttpError(409, 'This person is already a member');
  }
  await Invitation.updateMany({ workspace: workspace._id, email, status: 'pending' }, { $set: { status: 'revoked' } });
  const token = crypto.randomBytes(32).toString('hex');
  const invitation = await Invitation.create({
    workspace: workspace._id, email, role: data.role, tokenHash: sha(token), invitedBy: req.user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000)
  });
  if (existing) {
    await notify(existing.id, { actor: req.user.id, type: 'invitation', title: 'Workspace invitation', message: `${req.user.name} invited you to ${workspace.name} as ${data.role}.`, link: '/team' });
  }
  res.status(201).json({
    invitation: {
      id: invitation.id, email, role: data.role, expiresAt: invitation.expiresAt,
      acceptUrl: `${config.appPublicUrl}/invite/${token}`
    }
  });
}));

router.delete('/:id/invitations/:invId', asyncHandler(async (req, res) => {
  const { workspace } = await loadWorkspace(requireId(req.params.id), req.user.id, 'admin');
  await Invitation.updateOne({ _id: requireId(req.params.invId), workspace: workspace._id, status: 'pending' }, { $set: { status: 'revoked' } });
  res.json({ ok: true });
}));

export default router;
