import { Router } from 'express';
import Task from '../models/Task.js';
import Analysis from '../models/Analysis.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/http.js';
import { visibleTaskFilter } from '../services/access.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const visible = await visibleTaskFilter(req.user.id);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const open = { status: { $ne: 'done' } };

  const [byStatus, byPriority, overdue, dueToday, mine, doneThisWeek, upcoming, recent, analyses] = await Promise.all([
    Task.aggregate([{ $match: visible }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Task.aggregate([{ $match: { $and: [visible, open] } }, { $group: { _id: '$priority', n: { $sum: 1 } } }]),
    Task.countDocuments({ $and: [visible, open, { dueDate: { $lt: start } }] }),
    Task.countDocuments({ $and: [visible, open, { dueDate: { $gte: start, $lt: new Date(start.getTime() + 86400000) } }] }),
    Task.countDocuments({ $and: [visible, open, { assignee: req.user.id }] }),
    Task.countDocuments({ $and: [visible, { status: 'done', completedAt: { $gte: weekAgo } }] }),
    Task.find({ $and: [visible, open, { dueDate: { $ne: null } }] }).sort({ dueDate: 1 }).limit(6)
      .select('title status priority dueDate assignee').populate('assignee', 'name'),
    Task.find(visible).sort({ updatedAt: -1 }).limit(6).select('title status priority updatedAt assignee').populate('assignee', 'name'),
    Analysis.countDocuments({ user: req.user.id })
  ]);

  const status = Object.fromEntries(['todo', 'in_progress', 'review', 'done'].map((s) => [s, 0]));
  byStatus.forEach((r) => { status[r._id] = r.n; });
  const priority = Object.fromEntries(['low', 'medium', 'high', 'urgent'].map((s) => [s, 0]));
  byPriority.forEach((r) => { priority[r._id] = r.n; });
  const total = Object.values(status).reduce((a, b) => a + b, 0);

  res.json({
    totals: { total, completionRate: total ? Math.round((status.done / total) * 100) : 0, overdue, dueToday, assignedToMe: mine, doneThisWeek, analyses },
    status, priority, upcoming, recent
  });
}));

export default router;
