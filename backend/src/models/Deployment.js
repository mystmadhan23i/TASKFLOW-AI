import mongoose from 'mongoose';

export const DEPLOY_STATUSES = ['planned', 'deploying', 'verifying', 'live', 'rolled_back', 'failed', 'cancelled'];

const sampleSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  errorRate: Number, // %
  p95Ms: Number,
  cpuPct: Number,
  memPct: Number,
  rps: Number,
  healthy: { type: Boolean, default: true },
  source: { type: String, default: 'api' }
}, { _id: false });

const eventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  type: { type: String, default: 'info' },
  message: { type: String, maxlength: 500 },
  actor: { type: String, default: 'system' }
}, { _id: false });

const deploymentSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  version: { type: String, required: true, trim: true, maxlength: 60 },
  environment: { type: String, enum: ['production', 'staging'], default: 'production' },
  strategy: { type: String, enum: ['blue-green', 'canary', 'rolling', 'recreate'], default: 'blue-green' },
  status: { type: String, enum: DEPLOY_STATUSES, default: 'planned', index: true },
  activeColor: { type: String, enum: ['blue', 'green'], default: 'blue' }, // colour serving traffic before this release
  targetColor: { type: String, enum: ['blue', 'green'], default: 'green' }, // colour receiving the new version
  scheduledAt: Date,
  changelog: { type: String, default: '', maxlength: 4000 },
  input: { type: mongoose.Schema.Types.Mixed, default: {} },
  artifactName: { type: String, default: '' },
  artifactCounts: { type: mongoose.Schema.Types.Mixed, default: null },
  assessment: { type: mongoose.Schema.Types.Mixed, default: null }, // pre-deploy prediction
  liveAssessment: { type: mongoose.Schema.Types.Mixed, default: null }, // updated as samples arrive
  baseline: { errorRate: Number, p95Ms: Number },
  samples: [sampleSchema],
  events: [eventSchema],
  ingestTokenHash: { type: String, select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startedAt: Date,
  switchedAt: Date,
  finishedAt: Date,
  lastAlertLevel: { type: String, default: '' }
}, { timestamps: true });

deploymentSchema.index({ workspace: 1, createdAt: -1 });

export default mongoose.model('Deployment', deploymentSchema);
