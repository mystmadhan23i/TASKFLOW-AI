import mongoose from 'mongoose';

const findingSchema = new mongoose.Schema({
  id: String,
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low', 'info'] },
  title: String,
  detail: String,
  fix: String,
  line: Number
}, { _id: false });

const analysisSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  filename: { type: String, default: 'pasted-text' },
  detectedType: { type: String, enum: ['dockerfile', 'compose', 'logs', 'text'], default: 'text' },
  provider: { type: String, default: 'rules' },
  summary: { type: String, default: '' },
  findings: [findingSchema],
  nextSteps: [String],
  counts: { type: Map, of: Number },
  inputChars: Number,
  redactions: { type: Number, default: 0 },
  aiNote: { type: String, default: '' }
}, { timestamps: { createdAt: true, updatedAt: false } });

analysisSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Analysis', analysisSchema);
