import { Router } from 'express';
import Notification from '../models/Notification.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, requireId } from '../utils/http.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const filter = { user: req.user.id };
  if (req.query.unread === 'true') filter.readAt = null;
  const [notifications, unread] = await Promise.all([
    Notification.find(filter).populate('actor', 'name').sort({ createdAt: -1 }).limit(100),
    Notification.countDocuments({ user: req.user.id, readAt: null })
  ]);
  res.json({ notifications, unread });
}));

router.get('/unread-count', asyncHandler(async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ user: req.user.id, readAt: null }) });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user.id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ ok: true });
}));

router.patch('/:id/read', asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndUpdate({ _id: requireId(req.params.id), user: req.user.id }, { $set: { readAt: new Date() } }, { new: true });
  if (!n) throw new HttpError(404, 'Notification not found');
  res.json({ notification: n });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await Notification.deleteOne({ _id: requireId(req.params.id), user: req.user.id });
  res.json({ ok: true });
}));

export default router;
