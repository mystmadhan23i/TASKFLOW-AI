import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import Task, { STATUSES, PRIORITIES } from '../models/Task.js';
import Workspace from '../models/Workspace.js';
import Project from '../models/Project.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { visibleTaskFilter, roleOf, hasRole } from '../services/access.js';
import { notify } from '../services/notify.js';
import { config } from '../config.js';
import { uploadRoot, storedPath, removeStoredFiles } from '../services/files.js';

const router = Router();
router.use(requireAuth);

const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.js', '.mjs', '.html', '.htm', '.svg', '.php', '.jar']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(uploadRoot(), { recursive: true }); cb(null, uploadRoot()); },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`)
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (BLOCKED_EXT.has(path.extname(file.originalname).toLowerCase())) return cb(new HttpError(400, 'This file type is not allowed'));
    cb(null, true);
  }
});

const POPULATE = [
  { path: 'assignee', select: 'name email' },
  { path: 'createdBy', select: 'name email' },
  { path: 'project', select: 'name color' },
  { path: 'workspace', select: 'name' }
];
const DETAIL_POPULATE = [...POPULATE, { path: 'comments.author', select: 'name' }, { path: 'activity.actor', select: 'name' }];

const dateField = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]);
const labels = z.array(z.string().trim().min(1).max(30)).max(10);

const taskBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(160),
  description: z.string().max(8000).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: dateField.optional(),
  labels: labels.optional(),
  workspace: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  assignee: z.string().nullable().optional()
});

const toDate = (v) => (v ? new Date(v.length === 10 ? `${v}T12:00:00.000Z` : v) : null);

/** Resolve the caller's permissions for a task. */
async function permissionsFor(task, userId) {
  if (!task.workspace) {
    const own = String(task.createdBy) === String(userId);
    return { canView: own, canEdit: own, canDelete: own, role: own ? 'owner' : null };
  }
  const workspace = await Workspace.findById(task.workspace);
  const role = workspace ? roleOf(workspace, userId) : null;
  return {
    canView: !!role,
    canEdit: hasRole(role, 'member'),
    canDelete: hasRole(role, 'admin') || (hasRole(role, 'member') && String(task.createdBy) === String(userId)),
    role,
    workspace
  };
}

async function loadTask(id, userId, need = 'canView') {
  const task = await Task.findById(requireId(id));
  if (!task) throw new HttpError(404, 'Task not found');
  const perms = await permissionsFor(task, userId);
  if (!perms.canView) throw new HttpError(404, 'Task not found');
  if (!perms[need]) throw new HttpError(403, 'You do not have permission to do that');
  return { task, perms };
}

/** Validate workspace/project/assignee references and return normalized ids. */
async function resolveRefs(data, userId) {
  const out = {};
  if (data.workspace !== undefined) {
    if (data.workspace) {
      const ws = await Workspace.findById(requireId(data.workspace, 'workspace'));
      if (!ws || !hasRole(roleOf(ws, userId), 'member')) throw new HttpError(403, 'You cannot create tasks in that workspace');
    }
    out.workspace = data.workspace || null;
  }
  return out;
}

async function checkProjectAndAssignee(workspaceId, data) {
  if (data.project) {
    const p = await Project.findById(requireId(data.project, 'project'));
    if (!p || String(p.workspace) !== String(workspaceId)) throw new HttpError(400, 'Project does not belong to this workspace');
  }
  if (data.assignee) {
    if (!workspaceId) throw new HttpError(400, 'Personal tasks cannot be assigned to others');
    const ws = await Workspace.findById(workspaceId);
    if (!ws || !roleOf(ws, requireId(data.assignee, 'assignee'))) throw new HttpError(400, 'Assignee must be a member of the workspace');
  }
}

const label = { todo: 'To do', in_progress: 'In progress', review: 'In review', done: 'Done' };

/* ------------------------------------------------------------------ list */
router.get('/', asyncHandler(async (req, res) => {
  const q = req.query;
  const and = [await visibleTaskFilter(req.user.id)];
  if (q.workspace === 'personal') and.push({ workspace: null });
  else if (q.workspace) and.push({ workspace: requireId(String(q.workspace), 'workspace') });
  if (q.project) and.push({ project: requireId(String(q.project), 'project') });
  if (q.status && STATUSES.includes(q.status)) and.push({ status: q.status });
  if (q.priority && PRIORITIES.includes(q.priority)) and.push({ priority: q.priority });
  if (q.scope === 'mine') and.push({ assignee: req.user.id });
  if (q.scope === 'created') and.push({ createdBy: req.user.id });
  if (q.assignee === 'none') and.push({ assignee: null });
  else if (q.assignee) and.push({ assignee: requireId(String(q.assignee), 'assignee') });
  if (q.label) and.push({ labels: String(q.label) });
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  if (q.due === 'overdue') and.push({ dueDate: { $lt: startOfDay }, status: { $ne: 'done' } });
  if (q.due === 'today') and.push({ dueDate: { $gte: startOfDay, $lt: new Date(startOfDay.getTime() + 86400000) } });
  if (q.due === 'week') and.push({ dueDate: { $gte: startOfDay, $lt: new Date(startOfDay.getTime() + 7 * 86400000) } });
  if (q.q) {
    const rx = new RegExp(String(q.q).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ title: rx }, { description: rx }, { labels: rx }] });
  }
  const sorts = {
    recent: { updatedAt: -1 }, created: { createdAt: -1 }, due: { dueDate: 1, createdAt: -1 },
    priority: { priority: 1, createdAt: -1 }
  };
  const limit = Math.min(Number(q.limit) || 200, 500);
  const tasks = await Task.find({ $and: and }).select('-comments.text -activity').populate(POPULATE)
    .sort(sorts[q.sort] || sorts.recent).limit(limit);
  res.json({ tasks: tasks.map(summary) });
}));

function summary(t) {
  const o = t.toJSON();
  o.id = t.id;
  o.commentCount = t.comments.length;
  o.attachmentCount = t.attachments.length;
  delete o.comments; delete o.attachments;
  return o;
}

/* ---------------------------------------------------------------- create */
router.post('/', asyncHandler(async (req, res) => {
  const data = parse(taskBody, req.body);
  const refs = await resolveRefs({ workspace: data.workspace ?? null }, req.user.id);
  await checkProjectAndAssignee(refs.workspace, data);
  const task = await Task.create({
    title: data.title, description: data.description ?? '', status: data.status || 'todo',
    priority: data.priority || 'medium', dueDate: toDate(data.dueDate), labels: [...new Set(data.labels || [])],
    workspace: refs.workspace, project: data.project || null, assignee: data.assignee || null,
    completedAt: data.status === 'done' ? new Date() : null,
    createdBy: req.user.id, activity: [{ actor: req.user.id, action: 'created the task' }]
  });
  if (task.assignee) {
    await notify(task.assignee, { actor: req.user.id, type: 'task_assigned', title: 'New task assigned', message: `${req.user.name} assigned you “${task.title}”.`, link: `/tasks?open=${task.id}` });
  }
  await task.populate(POPULATE);
  res.status(201).json({ task: summary(task) });
}));

/* ------------------------------------------------------------------- get */
router.get('/:id', asyncHandler(async (req, res) => {
  const { task, perms } = await loadTask(req.params.id, req.user.id);
  await task.populate(DETAIL_POPULATE);
  res.json({ task: task.toJSON(), permissions: { canEdit: perms.canEdit, canDelete: perms.canDelete } });
}));

/* ---------------------------------------------------------------- update */
router.patch('/:id', asyncHandler(async (req, res) => {
  const { task } = await loadTask(req.params.id, req.user.id, 'canEdit');
  const data = parse(taskBody.partial(), req.body);
  if (data.workspace !== undefined && String(data.workspace || '') !== String(task.workspace || '')) {
    throw new HttpError(400, 'Moving a task between workspaces is not supported');
  }
  await checkProjectAndAssignee(task.workspace, data);

  const changes = [];
  const prevAssignee = task.assignee ? String(task.assignee) : null;
  const prevStatus = task.status;
  const set = (key, value, text) => {
    const before = task[key] instanceof Date ? task[key].getTime() : String(task[key] ?? '');
    const after = value instanceof Date ? value.getTime() : String(value ?? '');
    if (before !== after) { task[key] = value; if (text) changes.push(text); }
  };
  if (data.title !== undefined) set('title', data.title, 'renamed the task');
  if (data.description !== undefined) set('description', data.description, 'edited the description');
  if (data.priority !== undefined) set('priority', data.priority, `set priority to ${data.priority}`);
  if (data.dueDate !== undefined) set('dueDate', toDate(data.dueDate), data.dueDate ? `set the due date to ${data.dueDate.slice(0, 10)}` : 'cleared the due date');
  if (data.status !== undefined && data.status !== task.status) {
    task.status = data.status;
    task.completedAt = data.status === 'done' ? new Date() : null;
    changes.push(`moved the task to ${label[data.status]}`);
  }
  if (data.labels !== undefined) { task.labels = [...new Set(data.labels)]; changes.push('updated labels'); }
  if (data.project !== undefined) set('project', data.project || null, 'changed the project');
  if (data.assignee !== undefined) set('assignee', data.assignee || null, 'changed the assignee');
  if (!changes.length) {
    await task.populate(POPULATE);
    return res.json({ task: summary(task) });
  }
  changes.forEach((action) => task.activity.push({ actor: req.user.id, action }));
  if (task.activity.length > 100) task.activity = task.activity.slice(-100);
  await task.save();

  const link = `/tasks?open=${task.id}`;
  const newAssignee = task.assignee ? String(task.assignee) : null;
  if (newAssignee && newAssignee !== prevAssignee) {
    await notify(newAssignee, { actor: req.user.id, type: 'task_assigned', title: 'Task assigned to you', message: `${req.user.name} assigned you “${task.title}”.`, link });
  }
  if (task.status !== prevStatus) {
    await notify([task.createdBy, newAssignee], { actor: req.user.id, type: 'task_status', title: `Task ${task.status === 'done' ? 'completed' : 'moved'}`, message: `“${task.title}” is now ${label[task.status]}.`, link });
  } else if (changes.length) {
    await notify([task.assignee], { actor: req.user.id, type: 'task_updated', title: 'Task updated', message: `${req.user.name} ${changes[0]} on “${task.title}”.`, link });
  }
  await task.populate(POPULATE);
  res.json({ task: summary(task) });
}));

/* ---------------------------------------------------------------- delete */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { task } = await loadTask(req.params.id, req.user.id, 'canDelete');
  await removeStoredFiles(task.attachments);
  await task.deleteOne();
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- comments */
router.post('/:id/comments', asyncHandler(async (req, res) => {
  const { task } = await loadTask(req.params.id, req.user.id, 'canEdit');
  const { text } = parse(z.object({ text: z.string().trim().min(1, 'Comment cannot be empty').max(4000) }), req.body);
  task.comments.push({ author: req.user.id, text });
  await task.save();
  await notify([task.createdBy, task.assignee, ...task.comments.map((c) => c.author)], {
    actor: req.user.id, type: 'comment', title: 'New comment', message: `${req.user.name} commented on “${task.title}”: ${text.slice(0, 120)}`, link: `/tasks?open=${task.id}`
  });
  await task.populate('comments.author', 'name');
  res.status(201).json({ comment: task.comments[task.comments.length - 1] });
}));

router.delete('/:id/comments/:commentId', asyncHandler(async (req, res) => {
  const { task, perms } = await loadTask(req.params.id, req.user.id, 'canEdit');
  const comment = task.comments.id(requireId(req.params.commentId));
  if (!comment) throw new HttpError(404, 'Comment not found');
  if (String(comment.author) !== req.user.id && !hasRole(perms.role, 'admin')) throw new HttpError(403, 'You can only delete your own comments');
  comment.deleteOne();
  await task.save();
  res.json({ ok: true });
}));

/* ----------------------------------------------------------- attachments */
router.post('/:id/attachments', asyncHandler(async (req, res, next) => {
  await loadTask(req.params.id, req.user.id, 'canEdit');
  next();
}), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const task = await Task.findById(req.params.id);
  task.attachments.push({
    originalName: path.basename(req.file.originalname).slice(0, 200), storedName: req.file.filename,
    mimeType: req.file.mimetype, size: req.file.size, uploadedBy: req.user.id
  });
  task.activity.push({ actor: req.user.id, action: `attached ${path.basename(req.file.originalname).slice(0, 80)}` });
  await task.save();
  res.status(201).json({ attachment: task.attachments[task.attachments.length - 1] });
}));

router.get('/:id/attachments/:attId', asyncHandler(async (req, res) => {
  const { task } = await loadTask(req.params.id, req.user.id);
  const att = task.attachments.id(requireId(req.params.attId));
  if (!att) throw new HttpError(404, 'Attachment not found');
  const file = storedPath(att.storedName);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File is missing from storage');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.download(file, att.originalName);
}));

router.delete('/:id/attachments/:attId', asyncHandler(async (req, res) => {
  const { task } = await loadTask(req.params.id, req.user.id, 'canEdit');
  const att = task.attachments.id(requireId(req.params.attId));
  if (!att) throw new HttpError(404, 'Attachment not found');
  await removeStoredFiles([att]);
  att.deleteOne();
  await task.save();
  res.json({ ok: true });
}));

export default router;
