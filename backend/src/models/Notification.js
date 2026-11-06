import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, required: true },
  title: { type: String, required: true, maxlength: 200 },
  message: { type: String, default: '', maxlength: 500 },
  link: { type: String, default: '' },
  readAt: { type: Date, default: null }
}, { timestamps: { createdAt: true, updatedAt: false } });

notificationSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
