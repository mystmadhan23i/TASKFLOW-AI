import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import Invitation from '../models/Invitation.js';
import Workspace from '../models/Workspace.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { notify } from '../services/notify.js';

const router = Router();
router.use(requireAuth);

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function usable(invitation, user) {
  if (!invitation || invitation.status !== 'pending') throw new HttpError(404, 'Invitation not found or no longer valid');
  if (invitation.expiresAt < new Date()) throw new HttpError(410, 'This invitation has expired');
  if (invitation.email !== user.email) {
    throw new HttpError(403, `This invitation was sent to ${invitation.email}. Sign in with that email to accept it.`);
  }
}

async function accept(invitation, user) {
  const workspace = await Workspace.findById(invitation.workspace);
  if (!workspace) throw new HttpError(404, 'Workspace no longer exists');
  if (!workspace.members.some((m) => String(m.user) === user.id)) {
    workspace.members.push({ user: user.id, role: invitation.role });
    await workspace.save();
  }
  invitation.status = 'accepted';
  await invitation.save();
  await notify(invitation.invitedBy, { actor: user.id, type: 'invitation_accepted', title: 'Invitation accepted', message: `${user.name} joined ${workspace.name}.`, link: '/team' });
  return workspace;
}

// Pending invitations addressed to the signed-in user's email
router.get('/mine', asyncHandler(async (req, res) => {
  const list = await Invitation.find({ email: req.user.email, status: 'pending', expiresAt: { $gt: new Date() } })
    .populate('workspace', 'name').populate('invitedBy', 'name').sort({ createdAt: -1 });
  res.json({
    invitations: list.filter((i) => i.workspace).map((i) => ({
      id: i.id, workspaceName: i.workspace.name, role: i.role, invitedBy: i.invitedBy?.name || 'Someone', expiresAt: i.expiresAt
    }))
  });
}));

// Accept via emailed/shared link token
router.post('/accept', asyncHandler(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const invitation = await Invitation.findOne({ tokenHash: sha(token) });
  await usable(invitation, req.user);
  const workspace = await accept(invitation, req.user);
  res.json({ ok: true, workspaceId: workspace.id, message: `You joined ${workspace.name}.` });
}));

router.post('/:id/accept', asyncHandler(async (req, res) => {
  const invitation = await Invitation.findById(requireId(req.params.id));
  await usable(invitation, req.user);
  const workspace = await accept(invitation, req.user);
  res.json({ ok: true, workspaceId: workspace.id, message: `You joined ${workspace.name}.` });
}));

router.post('/:id/decline', asyncHandler(async (req, res) => {
  const invitation = await Invitation.findById(requireId(req.params.id));
  await usable(invitation, req.user);
  invitation.status = 'declined';
  await invitation.save();
  res.json({ ok: true });
}));

export default router;
