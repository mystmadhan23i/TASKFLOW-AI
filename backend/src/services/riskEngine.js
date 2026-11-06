/**
 * Deployment risk engine. Pure and deterministic so every number is explainable and testable.
 *
 * IMPORTANT: this is a transparent, rule-based scoring model blended with the workspace's own
 * deployment history — not a statistically trained model. It becomes more tailored as more
 * deployments finish, and an optional LLM can add narrative on top (see aiProvider.js).
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n);

export const LEVELS = [
  { max: 25, level: 'low' },
  { max: 50, level: 'medium' },
  { max: 75, level: 'high' },
  { max: 101, level: 'critical' }
];
export const levelFor = (score) => LEVELS.find((l) => score < l.max).level;

/** Map a 0–100 risk score to a success probability (%). 70 risk ≈ coin flip. */
export function successFromScore(score) {
  return clamp(round(100 / (1 + Math.exp((score - 70) / 14))), 3, 99);
}

/* -------------------------------------------------------------- pre-deploy */
export function assessPreDeploy(input = {}, history = { total: 0, succeeded: 0, recent: [] }, artifactCounts = null) {
  const f = []; // factors
  const add = (id, label, points, detail) => f.push({ id, label, points, detail, impact: points > 0 ? 'risk' : 'safety' });
  let known = 0;
  const has = (v) => { if (v !== undefined && v !== null && v !== '') known += 1; return v !== undefined && v !== null && v !== ''; };

  const strategy = input.strategy || 'blue-green';
  const env = input.environment || 'production';

  // Strategy
  if (strategy === 'blue-green') add('strategy', 'Blue/green strategy', -6, 'Zero-downtime cutover and instant rollback by switching traffic back to the previous colour.');
  else if (strategy === 'canary') add('strategy', 'Canary strategy', -4, 'Limits blast radius by exposing a small share of traffic first.');
  else if (strategy === 'recreate') add('strategy', 'Recreate strategy', 12, 'Stops the old version before starting the new one, so users see downtime and rollback is slow.');
  if (env !== 'production') add('env', 'Non-production target', -8, 'Lower blast radius than production.');

  // Change size
  if (has(input.linesChanged)) {
    const l = input.linesChanged;
    if (l > 1500) add('size', 'Very large change', 16, `${l} changed lines — large diffs hide regressions.`);
    else if (l > 500) add('size', 'Large change', 10, `${l} changed lines.`);
    else if (l > 150) add('size', 'Medium change', 5, `${l} changed lines.`);
    else if (l <= 50) add('size', 'Small change', -3, `Only ${l} changed lines — easy to reason about.`);
  }
  if (has(input.filesChanged)) {
    if (input.filesChanged > 40) add('files', 'Touches many files', 6, `${input.filesChanged} files changed.`);
    else if (input.filesChanged > 15) add('files', 'Touches many files', 3, `${input.filesChanged} files changed.`);
  }

  // Database migration — the #1 blue/green hazard: both colours share the database.
  const mig = input.dbMigration || 'none';
  has(input.dbMigration);
  if (mig === 'destructive') {
    add('migration', 'Destructive database migration', 26, 'In blue/green both versions use the same database; dropping or renaming columns can break the live (old) version immediately.');
    if (input.migrationReversible === false) add('migration-rev', 'Migration is not reversible', 8, 'A rollback of the application will not restore the previous schema or data.');
  } else if (mig === 'additive') add('migration', 'Additive database migration', 4, 'Backwards-compatible schema change; safe for both colours if applied first (expand/contract).');

  // Dependencies & config
  if (input.dependencyChanges === 'major') add('deps', 'Major dependency upgrade', 9, 'Major versions often include breaking changes.');
  else if (input.dependencyChanges === 'minor') add('deps', 'Minor dependency updates', 3, 'Low but non-zero regression risk.');
  has(input.dependencyChanges);
  if (input.configChanges === true) add('config', 'Environment / config changes', 5, 'Missing or wrong variables are a leading cause of failed releases.');

  // Quality signals
  if (input.testsPassRate === null || input.testsPassRate === undefined) add('tests', 'Test results unknown', 8, 'No automated test result was provided.');
  else {
    known += 1;
    const t = input.testsPassRate;
    if (t < 70) add('tests', 'Low test pass rate', 18, `Only ${t}% of tests pass.`);
    else if (t < 90) add('tests', 'Some tests failing', 10, `${t}% of tests pass.`);
    else if (t < 100) add('tests', 'Minor test failures', 4, `${t}% of tests pass.`);
    else add('tests', 'All tests passing', -4, 'The full automated test suite passes.');
  }
  if (has(input.coverage)) {
    if (input.coverage < 40) add('coverage', 'Low test coverage', 6, `${input.coverage}% coverage leaves much of the change unverified.`);
    else if (input.coverage >= 80) add('coverage', 'High test coverage', -3, `${input.coverage}% coverage.`);
  }

  // Readiness
  if (input.rollbackPlan === false) add('rollback', 'No tested rollback plan', 10, 'Without a rehearsed rollback, recovery time is unpredictable.');
  else if (input.rollbackPlan === true) add('rollback', 'Rollback plan in place', -5, 'Traffic can be switched back to the previous colour.');
  has(input.rollbackPlan);
  if (input.standbyReady === false) add('standby', 'Standby environment not verified', 8, 'The idle colour has not been provisioned and smoke-tested.');
  else if (input.standbyReady === true) add('standby', 'Standby environment verified', -4, 'The idle colour is provisioned and healthy.');
  has(input.standbyReady);
  if (input.monitoring === false) add('monitoring', 'No monitoring or alerts', 7, 'Problems after cutover may go unnoticed.');
  else if (input.monitoring === true) add('monitoring', 'Monitoring and alerts ready', -3, 'Errors and latency will be detected quickly.');
  has(input.monitoring);
  if (input.featureFlags === true) add('flags', 'Feature flags protect new behaviour', -3, 'Risky features can be disabled without redeploying.');
  if (input.hotfix === true) add('hotfix', 'Hotfix under time pressure', 6, 'Rushed changes bypass normal review and soak time.');

  // Timing (evaluated in the scheduler's local time)
  if (input.scheduledAt) {
    known += 1;
    const d = new Date(new Date(input.scheduledAt).getTime() - (input.tzOffsetMinutes || 0) * 60000); // shift to local clock
    const day = d.getUTCDay(); const hour = d.getUTCHours();
    if (day === 5 && hour >= 15) add('timing', 'Late-Friday release', 8, 'Few people are around to respond over the weekend.');
    else if (day === 0 || day === 6) add('timing', 'Weekend release', 6, 'Reduced staffing for incident response.');
    else if (hour < 6 || hour >= 22) add('timing', 'Off-hours release', 4, 'On-call response may be slower at night.');
    else if (day >= 2 && day <= 4 && hour >= 10 && hour < 15) add('timing', 'Mid-week business-hours release', -3, 'The team is available to react quickly.');
  }

  // Docker artifacts analysed by the rule engine
  if (artifactCounts) {
    known += 1;
    const c = artifactCounts;
    const crit = Math.min(21, (c.critical || 0) * 7);
    const high = Math.min(12, (c.high || 0) * 3);
    if (crit) add('artifacts-critical', 'Critical Docker/Compose issues', crit, `${c.critical} critical finding(s) in the supplied Docker files.`);
    if (high) add('artifacts-high', 'High-severity Docker/Compose issues', high, `${c.high} high-severity finding(s) in the supplied Docker files.`);
    if (!crit && !high) add('artifacts-ok', 'Docker files pass critical checks', -2, 'No critical or high-severity findings in the supplied Docker files.');
  }

  // History
  const recent = history.recent || [];
  const recentFails = recent.slice(0, 3).filter((s) => s !== 'live').length;
  if (recentFails > 0) add('history', 'Recent failed deployments', recentFails * 5, `${recentFails} of the last ${Math.min(3, recent.length)} deployments did not succeed.`);
  else if (recent.length >= 3) add('history', 'Clean recent history', -3, 'The last three deployments succeeded.');

  // Safety credits are capped so good hygiene can never fully cancel out genuine hazards.
  const riskPts = f.filter((x) => x.points > 0).reduce((s, x) => s + x.points, 0);
  const safetyPts = Math.max(-18, f.filter((x) => x.points < 0).reduce((s, x) => s + x.points, 0));
  const raw = 10 + riskPts + safetyPts;
  const riskScore = clamp(round(raw), 2, 100); // no release is ever risk-free
  const modelP = successFromScore(riskScore);
  const n = history.total || 0;
  const histRate = ((history.succeeded || 0) + 8) / (n + 9) * 100; // Beta(8,1)-style prior
  const w = 0.5 * (n / (n + 10));
  const successProbability = clamp(round((1 - w) * modelP + w * histRate), 3, 99);

  const level = levelFor(riskScore);
  const confidence = known >= 10 ? 'high' : known >= 6 ? 'medium' : 'low';

  const factors = [...f].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const pros = [];
  const cons = [];
  const mitigations = [];
  if (strategy === 'blue-green') {
    pros.push('Zero-downtime cutover: users stay on the live colour until the new one is verified.');
    pros.push('Instant rollback: flip traffic back to the previous colour — no rebuild required.');
    cons.push('Temporarily doubles infrastructure while both colours run.');
    cons.push('Both colours share the database and storage, so schema changes must work with both versions.');
    cons.push('Long-lived sessions and in-flight jobs need to survive the cutover.');
  }
  for (const x of factors) {
    if (x.points <= -3) pros.push(`${x.label}: ${x.detail}`);
    else if (x.points >= 5) cons.push(`${x.label}: ${x.detail}`);
  }
  const fix = {
    migration: 'Use expand/contract: ship an additive migration first, deploy, then remove old columns in a later release.',
    'migration-rev': 'Take a verified database backup immediately before cutover and write a down-migration.',
    tests: 'Run the full test suite and block the release until it passes.',
    size: 'Split the release into smaller changes, or enable the riskiest parts behind a feature flag.',
    rollback: 'Rehearse the rollback (switch to the old colour and back) in staging before production.',
    standby: 'Provision the idle colour and run smoke tests against it before switching traffic.',
    monitoring: 'Add alerts for error rate, p95 latency and health checks before cutover.',
    timing: 'Schedule the cutover for mid-week business hours when the team can respond.',
    deps: 'Review the changelogs of upgraded packages and run an integration test pass.',
    config: 'Diff the environment variables between colours and verify all required secrets exist.',
    history: 'Review the cause of the recent failures and confirm they are fixed.',
    'artifacts-critical': 'Fix the critical Docker findings (see the Docker analyzer report) before building the release.',
    'artifacts-high': 'Address high-severity Docker findings or accept them explicitly.'
  };
  factors.filter((x) => x.points >= 5 && fix[x.id]).forEach((x) => mitigations.push(fix[x.id]));

  const recommendation = riskScore < 25
    ? { action: 'proceed', text: 'Risk is low. Deploy to the idle colour, verify health, then switch traffic.' }
    : riskScore < 50
      ? { action: 'proceed_with_caution', text: 'Moderate risk. Deploy to the idle colour, watch live metrics for several minutes, and keep the previous colour running for fast rollback.' }
      : { action: 'hold', text: 'Elevated risk. Resolve the listed mitigations before switching production traffic.' };

  return { riskScore, level, successProbability, confidence, factors, pros: dedupe(pros), cons: dedupe(cons), mitigations: dedupe(mitigations), recommendation, historyUsed: { deployments: n, weight: Number(w.toFixed(2)) } };
}

const dedupe = (arr) => [...new Set(arr)];

/* ------------------------------------------------------------------- live */
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Re-assess while the new (idle) colour is being verified, using observed health samples.
 * samples: [{ at, errorRate (%), p95Ms, cpuPct, memPct, healthy }]   baseline: { errorRate, p95Ms }
 */
export function assessLive(pre, samples = [], baseline = {}) {
  const recent = samples.slice(-6);
  const n = recent.length;
  if (!pre) return null;
  if (n === 0) return { ...pre, phase: 'pre-deploy', verdict: 'waiting', signals: [], samples: 0, recommendation: { action: 'wait', text: 'Waiting for health samples from the new colour.' } };

  const baseErr = baseline.errorRate ?? 0.5;
  const baseP95 = baseline.p95Ms || 0;
  const err = avg(recent.filter((s) => s.errorRate != null).map((s) => s.errorRate));
  const p95 = avg(recent.filter((s) => s.p95Ms != null).map((s) => s.p95Ms));
  const cpu = avg(recent.filter((s) => s.cpuPct != null).map((s) => s.cpuPct));
  const mem = avg(recent.filter((s) => s.memPct != null).map((s) => s.memPct));
  const failedChecks = recent.filter((s) => s.healthy === false).length;

  const signals = [];
  let observed = 0;
  const sig = (label, value, status, points) => { signals.push({ label, value, status }); observed += points; };

  if (err >= 5) sig('Error rate', `${err.toFixed(2)}%`, 'bad', 45);
  else if (err >= 2) sig('Error rate', `${err.toFixed(2)}%`, 'bad', 28);
  else if (err > baseErr + 0.5) sig('Error rate', `${err.toFixed(2)}% (baseline ${baseErr}%)`, 'warn', 10);
  else sig('Error rate', `${err.toFixed(2)}%`, 'ok', 0);

  if (baseP95 > 0 && p95 > 0) {
    const ratio = p95 / baseP95;
    if (ratio > 2) sig('p95 latency', `${Math.round(p95)} ms (${ratio.toFixed(1)}× baseline)`, 'bad', 25);
    else if (ratio > 1.5) sig('p95 latency', `${Math.round(p95)} ms (${ratio.toFixed(1)}× baseline)`, 'warn', 15);
    else if (ratio > 1.2) sig('p95 latency', `${Math.round(p95)} ms (${ratio.toFixed(1)}× baseline)`, 'warn', 6);
    else sig('p95 latency', `${Math.round(p95)} ms`, 'ok', 0);
  } else if (p95 > 0) {
    sig('p95 latency', `${Math.round(p95)} ms`, p95 > 2000 ? 'bad' : p95 > 800 ? 'warn' : 'ok', p95 > 2000 ? 20 : p95 > 800 ? 8 : 0);
  }
  if (failedChecks) sig('Health checks', `${failedChecks} of last ${n} failed`, 'bad', Math.min(45, failedChecks * 15));
  else sig('Health checks', `${n} of ${n} passing`, 'ok', 0);
  if (mem >= 90) sig('Memory', `${mem.toFixed(0)}%`, 'bad', 12); else if (mem > 0) sig('Memory', `${mem.toFixed(0)}%`, mem >= 80 ? 'warn' : 'ok', mem >= 80 ? 5 : 0);
  if (cpu >= 90) sig('CPU', `${cpu.toFixed(0)}%`, 'bad', 10); else if (cpu > 0) sig('CPU', `${cpu.toFixed(0)}%`, cpu >= 80 ? 'warn' : 'ok', cpu >= 80 ? 4 : 0);

  const errs = recent.map((s) => s.errorRate).filter((v) => v != null);
  if (errs.length >= 4 && errs.every((v, i) => i === 0 || v >= errs[i - 1]) && errs[errs.length - 1] > errs[0] + 0.5) sig('Error trend', 'rising', 'warn', 6);

  const wObs = Math.min(1, n / 6); // trust observations more as samples accumulate
  const riskScore = clamp(round(pre.riskScore * (1 - 0.65 * wObs) + observed * wObs), 0, 100);
  const level = levelFor(riskScore);
  const hardFail = err >= 5 || failedChecks >= 3;
  const verdict = hardFail || level === 'critical' ? 'critical' : level === 'high' ? 'degraded' : n >= 3 && level === 'low' ? 'healthy' : 'watch';
  const recommendation = {
    critical: { action: 'rollback', text: 'The new colour is unhealthy. Do not switch traffic — or roll back to the previous colour now.' },
    degraded: { action: 'hold', text: 'Signals are degraded. Hold the cutover and investigate before sending traffic.' },
    healthy: { action: 'switch', text: 'Live signals are healthy. It is reasonable to switch traffic and keep the old colour for rollback.' },
    watch: { action: 'wait', text: 'Keep collecting samples; at least 3 healthy samples are recommended before cutover.' }
  }[verdict];

  const pros = [...pre.pros];
  const cons = [...pre.cons];
  if (verdict === 'healthy') pros.unshift(`Observed health is good over ${n} samples (errors ${err.toFixed(2)}%).`);
  signals.filter((s) => s.status !== 'ok').forEach((s) => cons.unshift(`Live signal — ${s.label}: ${s.value}.`));

  return {
    ...pre, phase: 'live', riskScore, level, successProbability: successFromScore(riskScore), verdict, signals, samples: n,
    pros: dedupe(pros), cons: dedupe(cons), recommendation
  };
}

/** Success statistics for a list of past deployments (newest first). */
export function summarizeHistory(deployments) {
  const finished = deployments.filter((d) => ['live', 'rolled_back', 'failed'].includes(d.status));
  const succeeded = finished.filter((d) => d.status === 'live').length;
  return { total: finished.length, succeeded, recent: finished.slice(0, 5).map((d) => d.status), rate: finished.length ? Math.round((succeeded / finished.length) * 100) : null };
}
