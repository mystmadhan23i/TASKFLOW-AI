import mongoose from 'mongoose';

export const ROLES = ['owner', 'admin', 'member', 'viewer'];

const workspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  description: { type: String, default: '', maxlength: 500 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{
    _id: false,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, default: 'member' },
    joinedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

workspaceSchema.index({ 'members.user': 1 });

export default mongoose.model('Workspace', workspaceSchema);
