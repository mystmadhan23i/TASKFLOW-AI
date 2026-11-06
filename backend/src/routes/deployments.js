import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import Deployment from '../models/Deployment.js';
import Workspace from '../models/Workspace.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { loadWorkspace, myWorkspaceIds, hasRole } from '../services/access.js';
import { notify } from '../services/notify.js';
import { assessPreDeploy, assessLive, summarizeHistory } from '../services/riskEngine.js';
import { analyzeText as analyzeDocker } from '../services/dockerAnalyzer.js';
import { narrateDeployment, aiConfigured } from '../services/aiProvider.js';
import { config } from '../config.js';

const router = Router();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const ACTIVE = ['planned', 'deploying', 'verifying'];

/* ---------------------------------------------------------------- schemas */
const bool = z.boolean().optional();
const inputSchema = z.object({
  linesChanged: z.number().int().min(0).max(1e7).optional(),
  filesChanged: z.number().int().min(0).max(1e5).optional(),
  dbMigration: z.enum(['none', 'additive', 'destructive']).optional(),
  migrationReversible: bool,
  dependencyChanges: z.enum(['none', 'minor', 'major']).optional(),
  configChanges: bool,
  testsPassRate: z.number().min(0).max(100).nullable().optional(),
  coverage: z.number().min(0).max(100).nullable().optional(),
  rollbackPlan: bool, standbyReady: bool, monitoring: bool, featureFlags: bool, hotfix: bool,
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional()
});
const createSchema = inputSchema.extend({
  workspace: z.string(),
  name: z.string().trim().min(2).max(120),
  version: z.string().trim().min(1).max(60),
  environment: z.enum(['production', 'staging']).default('production'),
  strategy: z.enum(['blue-green', 'canary', 'rolling', 'recreate']).default('blue-green'),
  activeColor: z.enum(['blue', 'green']).default('blue'),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  changelog: z.string().max(4000).optional().default(''),
  artifactName: z.string().max(150).optional().default(''),
  artifactText: z.string().max(60000).optional().default(''),
  baseline: z.object({ errorRate: z.number().min(0).max(100).optional(), p95Ms: z.number().min(0).max(600000).optional() }).optional()
});
const sampleSchema = z.object({
  errorRate: z.number().min(0).max(100).optional(),
  p95Ms: z.number().min(0).max(600000).optional(),
  cpuPct: z.number().min(0).max(100).optional(),
  memPct: z.number().min(0).max(100).optional(),
  rps: z.number().min(0).max(1e7).optional(),
  healthy: z.boolean().optional()
});

/* ---------------------------------------------------------------- helpers */
const other = (c) => (c === 'blue' ? 'green' : 'blue');

async function historyFor(workspaceId, excludeId) {
  const past = await Deployment.find({ workspace: workspaceId, _id: { $ne: excludeId }, status: { $in: ['live', 'rolled_back', 'failed'] } })
    .sort({ createdAt: -1 }).limit(30).select('status');
  return summarizeHistory(past);
}

function pushEvent(d, type, message, actor = 'system') {
  d.events.push({ type, message, actor });
  if (d.events.length > 200) d.events = d.events.slice(-200);
}

async function assess(d) {
  const history = await historyFor(d.workspace, d._id);
  const input = { ...d.input, strategy: d.strategy, environment: d.environment, scheduledAt: d.scheduledAt };
  const pre = assessPreDeploy(input, history, d.artifactCounts);
  d.assessment = pre;
  d.markModified('assessment');
  refreshLive(d);
  return history;
}

function refreshLive(d) {
  const samples = d.samples.map((s) => (s.toObject ? s.toObject() : s));
  d.liveAssessment = assessLive(d.assessment, samples, d.baseline || {});
  d.markModified('liveAssessment');
}

async function addNarrative(d) {
  const current = d.liveAssessment || d.assessment;
  const ai = await narrateDeployment(current, d);
  if (!ai) return;
  d.assessment = { ...d.assessment, ai: ai.error ? { error: ai.error } : ai };
  d.markModified('assessment');
  refreshLive(d);
  if (d.liveAssessment) { d.liveAssessment.ai = d.assessment.ai; d.markModified('liveAssessment'); }
}

async function alertTeam(d, title, message, extra = []) {
  const ws = await Workspace.findById(d.workspace).select('members');
  const admins = ws.members.filter((m) => hasRole(m.role, 'admin')).map((m) => m.user);
  await notify([d.createdBy, ...admins, ...extra], { actor: null, type: 'deployment', title, message, link: `/deployments/${d.id}` });
}

/** Alert once whenever the live level crosses into high/critical. */
async function maybeAlert(d) {
  const lvl = d.liveAssessment?.level;
  if (!lvl || lvl === d.lastAlertLevel) return;
  if (['high', 'critical'].includes(lvl) && d.liveAssessment.phase === 'live') {
    await alertTeam(d, `Deployment risk ${lvl}`, `${d.name} ${d.version}: ${d.liveAssessment.recommendation.text}`);
  }
  d.lastAlertLevel = lvl;
}

const view = (d, { full = false } = {}) => {
  const o = d.toJSON();
  delete o.ingestTokenHash; delete o.artifactText;
  o.samples = full ? (o.samples || []).slice(-60) : undefined;
  if (!full) { delete o.events; delete o.samples; }
  o.sampleCount = d.samples.length;
  return o;
};

/** Apply a lifecycle action. Returns a human message. Shared by the UI and the ingest API. */
async function applyAction(d, action, { actor = 'system', force = false, reason = '' } = {}) {
  const guard = (from) => { if (!from.includes(d.status)) throw new HttpError(409, `Cannot ${action} a deployment that is ${d.status}.`); };
  const now = new Date();
  switch (action) {
    case 'start': guard(['planned']); d.status = 'deploying'; d.startedAt = now; pushEvent(d, 'status', `Deployment started — building ${d.version} on ${d.targetColor}.`, actor); break;
    case 'verify': guard(['planned', 'deploying']); d.status = 'verifying'; d.startedAt ||= now; pushEvent(d, 'status', `${d.targetColor} is running ${d.version}; verifying health before cutover.`, actor); break;
    case 'switch': {
      guard(['verifying', 'deploying']);
      const lvl = d.liveAssessment?.level;
      if (['high', 'critical'].includes(lvl) && !force) throw new HttpError(409, `Risk is ${lvl}: ${d.liveAssessment.recommendation.text} Use “Switch anyway” to override.`);
      d.status = 'live'; d.switchedAt = now; d.finishedAt = now;
      pushEvent(d, 'switch', `Traffic switched from ${d.activeColor} to ${d.targetColor}${force ? ` (forced${reason ? `: ${reason}` : ''})` : ''}.`, actor);
      break;
    }
    case 'rollback': guard(['verifying', 'deploying', 'live']); d.status = 'rolled_back'; d.finishedAt = now; pushEvent(d, 'rollback', `Rolled back: traffic served by ${d.activeColor}.${reason ? ` Reason: ${reason}` : ''}`, actor); break;
    case 'fail': guard(['planned', 'deploying', 'verifying']); d.status = 'failed'; d.finishedAt = now; pushEvent(d, 'fail', `Deployment failed.${reason ? ` ${reason}` : ''}`, actor); break;
    case 'cancel': guard(['planned']); d.status = 'cancelled'; d.finishedAt = now; pushEvent(d, 'status', 'Deployment cancelled.', actor); break;
    default: throw new HttpError(400, 'Unknown action');
  }
  return d.status;
}

/* ================================================================ ingest
 * Token-authenticated endpoints for CI/CD and the blue/green scripts (no user session).
 * The token is shown once at creation and stored hashed. */
async function ingestAuth(req, res, next) {
  const token = String(req.headers['x-ingest-token'] || '');
  if (!/^[a-f0-9]{48}$/.test(token)) throw new HttpError(401, 'Missing or invalid ingest token');
  const d = await Deployment.findById(requireId(req.params.id)).select('+ingestTokenHash');
  const ok = d?.ingestTokenHash && crypto.timingSafeEqual(Buffer.from(d.ingestTokenHash), Buffer.from(sha(token)));
  if (!ok) throw new HttpError(401, 'Missing or invalid ingest token');
  req.deployment = d;
  next();
}
const ingestLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

router.post('/:id/ingest', ingestLimit, asyncHandler(ingestAuth), asyncHandler(async (req, res) => {
  const d = req.deployment;
  const body = parse(z.discriminatedUnion('type', [
    z.object({ type: z.literal('metrics') }).merge(sampleSchema),
    z.object({ type: z.literal('event'), message: z.string().trim().min(1).max(500) }),
    z.object({ type: z.literal('status'), action: z.enum(['start', 'verify', 'switch', 'rollback', 'fail']), reason: z.string().max(300).optional() }),
    z.object({ type: z.literal('baseline'), errorRate: z.number().min(0).max(100).optional(), p95Ms: z.number().min(0).max(600000).optional() })
  ]), req.body);

  if (body.type === 'metrics') {
    if (!['deploying', 'verifying', 'live'].includes(d.status)) throw new HttpError(409, `Deployment is ${d.status}; metrics are not accepted.`);
    const { type, ...sample } = body;
    d.samples.push({ ...sample, source: 'ingest' });
    if (d.samples.length > 300) d.samples = d.samples.slice(-300);
    refreshLive(d);
    await maybeAlert(d);
  } else if (body.type === 'event') pushEvent(d, 'info', body.message, 'script');
  else if (body.type === 'baseline') { d.baseline = { errorRate: body.errorRate, p95Ms: body.p95Ms }; refreshLive(d); pushEvent(d, 'info', 'Baseline metrics recorded from the live colour.', 'script'); }
  else {
    const before = d.status;
    await applyAction(d, body.action, { actor: 'script', force: true, reason: body.reason });
    if (d.status !== before) await alertTeam(d, `Deployment ${d.status.replace('_', ' ')}`, `${d.name} ${d.version} is now ${d.status.replace('_', ' ')}.`);
  }
  await d.save();
  res.json({ ok: true, status: d.status, level: d.liveAssessment?.level, verdict: d.liveAssessment?.verdict });
}));

// AI gate: scripts ask whether it is safe to switch before flipping traffic.
router.get('/:id/gate', ingestLimit, asyncHandler(ingestAuth), asyncHandler(async (req, res) => {
  const a = req.deployment.liveAssessment || req.deployment.assessment;
  res.json({
    status: req.deployment.status, riskScore: a.riskScore, level: a.level, successProbability: a.successProbability,
    verdict: a.verdict || 'pre-deploy', samples: a.samples || 0, action: a.recommendation.action, message: a.recommendation.text,
    allowSwitch: !['high', 'critical'].includes(a.level) && (a.samples || 0) >= 3 && a.verdict !== 'critical'
  });
}));

/* ============================================================ user routes */
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const filter = { workspace: { $in: await myWorkspaceIds(req.user.id) } };
  if (req.query.workspace) filter.workspace = requireId(String(req.query.workspace), 'workspace');
  const list = await Deployment.find(filter).sort({ createdAt: -1 }).limit(100);
  const stats = summarizeHistory(list);
  res.json({ deployments: list.map((d) => view(d)), stats });
}));

router.get('/status', (req, res) => res.json({ aiConfigured: aiConfigured() }));

// Stateless preview used by the form for an instant, as-you-type prediction. Nothing is saved.
router.post('/predict', asyncHandler(async (req, res) => {
  const data = parse(createSchema.partial(), req.body);
  const { workspace, name, version, environment, strategy, activeColor, scheduledAt, changelog, artifactName, artifactText, baseline, ...input } = data;
  let history = { total: 0, succeeded: 0, recent: [] };
  if (workspace) {
    await loadWorkspace(requireId(workspace, 'workspace'), req.user.id);
    history = await historyFor(workspace, null);
  }
  const counts = artifactText?.trim() ? analyzeDocker(artifactText, artifactName || '').counts : null;
  res.json({ assessment: assessPreDeploy({ ...input, strategy, environment, scheduledAt }, history, counts) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = parse(createSchema, req.body);
  await loadWorkspace(requireId(data.workspace, 'workspace'), req.user.id, 'member');
  const { workspace, name, version, environment, strategy, activeColor, scheduledAt, changelog, artifactName, artifactText, baseline, ...input } = data;
  let artifactCounts = null;
  if (artifactText.trim()) artifactCounts = analyzeDocker(artifactText, artifactName).counts;
  const token = crypto.randomBytes(24).toString('hex');
  const d = new Deployment({
    workspace, name, version, environment, strategy, activeColor, targetColor: other(activeColor),
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null, changelog, artifactName, artifactCounts, input,
    baseline: baseline || {}, createdBy: req.user.id, ingestTokenHash: sha(token)
  });
  await assess(d);
  pushEvent(d, 'created', `Deployment planned by ${req.user.name}. Predicted risk ${d.assessment.riskScore}/100, success ${d.assessment.successProbability}%.`, req.user.name);
  await addNarrative(d);
  await d.save();
  if (['high', 'critical'].includes(d.assessment.level)) await alertTeam(d, `High-risk deployment planned`, `${name} ${version}: predicted risk ${d.assessment.riskScore}/100.`);
  res.status(201).json({ deployment: view(d, { full: true }), ingestToken: token });
}));

async function loadDeployment(id, userId, min = 'viewer') {
  const d = await Deployment.findById(requireId(id));
  if (!d) throw new HttpError(404, 'Deployment not found');
  await loadWorkspace(d.workspace, userId, min);
  return d;
}

router.get('/:id', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id);
  res.json({ deployment: view(d, { full: true }), apiBase: config.appPublicUrl });
}));

// Update inputs of a not-yet-finished deployment and re-run the prediction.
router.patch('/:id', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'member');
  if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'Finished deployments cannot be edited');
  const data = parse(inputSchema.extend({
    changelog: z.string().max(4000).optional(), scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
    baseline: z.object({ errorRate: z.number().min(0).max(100).optional(), p95Ms: z.number().min(0).max(600000).optional() }).optional(),
    artifactName: z.string().max(150).optional(), artifactText: z.string().max(60000).optional()
  }), req.body);
  const { changelog, scheduledAt, baseline, artifactName, artifactText, ...input } = data;
  d.input = { ...d.input, ...input };
  if (changelog !== undefined) d.changelog = changelog;
  if (scheduledAt !== undefined) d.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  if (baseline) d.baseline = { ...(d.baseline?.toObject?.() || d.baseline), ...baseline };
  if (artifactText !== undefined) { d.artifactName = artifactName || d.artifactName; d.artifactCounts = artifactText.trim() ? analyzeDocker(artifactText, d.artifactName).counts : null; }
  d.markModified('input');
  await assess(d);
  pushEvent(d, 'assess', `Prediction refreshed: risk ${d.assessment.riskScore}/100, success ${d.assessment.successProbability}%.`, req.user.name);
  await addNarrative(d);
  await d.save();
  res.json({ deployment: view(d, { full: true }) });
}));

router.post('/:id/transition', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'member');
  const { action, force, reason } = parse(z.object({
    action: z.enum(['start', 'verify', 'switch', 'rollback', 'fail', 'cancel']), force: z.boolean().optional(), reason: z.string().max(300).optional()
  }), req.body);
  if (force && !(await loadWorkspace(d.workspace, req.user.id, 'admin').catch(() => null))) throw new HttpError(403, 'Only workspace admins can override the risk gate');
  await applyAction(d, action, { actor: req.user.name, force, reason });
  await d.save();
  if (['switch', 'rollback', 'fail'].includes(action)) await alertTeam(d, `Deployment ${d.status.replace('_', ' ')}`, `${req.user.name}: ${d.name} ${d.version} is now ${d.status.replace('_', ' ')}.`);
  res.json({ deployment: view(d, { full: true }) });
}));

// Manual / demo health sample from the UI (real pipelines use /ingest).
router.post('/:id/metrics', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'member');
  if (!['deploying', 'verifying', 'live'].includes(d.status)) throw new HttpError(409, 'Start the deployment before adding health samples');
  d.samples.push({ ...parse(sampleSchema, req.body), source: 'manual' });
  if (d.samples.length > 300) d.samples = d.samples.slice(-300);
  refreshLive(d);
  await maybeAlert(d);
  await d.save();
  res.status(201).json({ deployment: view(d, { full: true }) });
}));

router.post('/:id/reassess-ai', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'member');
  await addNarrative(d);
  await d.save();
  res.json({ deployment: view(d, { full: true }) });
}));

router.post('/:id/rotate-token', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'admin');
  const token = crypto.randomBytes(24).toString('hex');
  d.ingestTokenHash = sha(token);
  await d.save();
  res.json({ ingestToken: token });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const d = await loadDeployment(req.params.id, req.user.id, 'admin');
  await d.deleteOne();
  res.json({ ok: true });
}));

export default router;
