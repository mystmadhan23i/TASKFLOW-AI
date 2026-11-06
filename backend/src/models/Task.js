import mongoose from 'mongoose';

export const STATUSES = ['todo', 'in_progress', 'review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const commentSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 4000 }
}, { timestamps: { createdAt: true, updatedAt: false } });

const attachmentSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  storedName: { type: String, required: true },
  mimeType: { type: String, default: 'application/octet-stream' },
  size: { type: Number, required: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: { createdAt: true, updatedAt: false } });

const activitySchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true, maxlength: 300 },
  at: { type: Date, default: Date.now }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, default: '', maxlength: 8000 },
  status: { type: String, enum: STATUSES, default: 'todo', index: true },
  priority: { type: String, enum: PRIORITIES, default: 'medium' },
  dueDate: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  labels: [{ type: String, trim: true, maxlength: 30 }],
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  comments: [commentSchema],
  attachments: [attachmentSchema],
  activity: [activitySchema]
}, { timestamps: true });

taskSchema.index({ title: 'text', description: 'text' });

export default mongoose.model('Task', taskSchema);
