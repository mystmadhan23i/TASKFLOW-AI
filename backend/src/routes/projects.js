import { Router } from 'express';
import { z } from 'zod';
import Project from '../models/Project.js';
import Task from '../models/Task.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { loadWorkspace, myWorkspaceIds } from '../services/access.js';

const router = Router();
router.use(requireAuth);

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).optional();

router.get('/', asyncHandler(async (req, res) => {
  const filter = { workspace: { $in: await myWorkspaceIds(req.user.id) } };
  if (req.query.workspace) filter.workspace = requireId(String(req.query.workspace), 'workspace');
  const projects = await Project.find(filter).sort({ createdAt: -1 });
  const counts = await Task.aggregate([
    { $match: { project: { $in: projects.map((p) => p._id) } } },
    { $group: { _id: '$project', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } } } }
  ]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({
    projects: projects.map((p) => ({
      ...p.toJSON(), id: p.id, taskCount: byId[p.id]?.total || 0, doneCount: byId[p.id]?.done || 0
    }))
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = parse(z.object({
    workspace: z.string(), name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).optional().default(''), color
  }), req.body);
  await loadWorkspace(requireId(data.workspace, 'workspace'), req.user.id, 'member');
  const project = await Project.create({ ...data, createdBy: req.user.id });
  res.status(201).json({ project });
}));

async function loadProject(id, userId, min) {
  const project = await Project.findById(requireId(id));
  if (!project) throw new HttpError(404, 'Project not found');
  await loadWorkspace(project.workspace, userId, min);
  return project;
}

router.patch('/:id', asyncHandler(async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id, 'member');
  const data = parse(z.object({
    name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(2000).optional(),
    color, archived: z.boolean().optional()
  }), req.body);
  Object.assign(project, data);
  await project.save();
  res.json({ project });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const project = await loadProject(req.params.id, req.user.id, 'admin');
  await Task.updateMany({ project: project._id }, { $set: { project: null } });
  await project.deleteOne();
  res.json({ ok: true });
}));

export default router;
