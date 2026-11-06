import mongoose from 'mongoose';

const invitationSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  role: { type: String, enum: ['admin', 'member', 'viewer'], default: 'member' },
  tokenHash: { type: String, required: true, unique: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'revoked'], default: 'pending' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

export default mongoose.model('Invitation', invitationSchema);
