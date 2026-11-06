import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPreDeploy, assessLive, successFromScore, summarizeHistory } from '../src/services/riskEngine.js';

const safe = { strategy: 'blue-green', environment: 'production', linesChanged: 40, filesChanged: 3, dbMigration: 'none', testsPassRate: 100, coverage: 85, rollbackPlan: true, standbyReady: true, monitoring: true, scheduledAt: '2026-11-04T10:30:00Z' };
const risky = { strategy: 'recreate', linesChanged: 2400, filesChanged: 60, dbMigration: 'destructive', migrationReversible: false, dependencyChanges: 'major', configChanges: true, testsPassRate: 62, rollbackPlan: false, standbyReady: false, monitoring: false, scheduledAt: '2026-11-06T17:00:00Z' };

test('success probability is monotonic and bounded', () => {
  let prev = 100;
  for (let s = 0; s <= 100; s += 5) { const p = successFromScore(s); assert.ok(p <= prev && p >= 3 && p <= 99); prev = p; }
});

test('safe blue/green release scores low risk with high success', () => {
  const r = assessPreDeploy(safe);
  assert.equal(r.level, 'low');
  assert.ok(r.successProbability >= 90, `got ${r.successProbability}`);
  assert.equal(r.recommendation.action, 'proceed');
  assert.ok(r.pros.length >= 3);
});

test('risky release is high/critical, holds, and explains why', () => {
  const r = assessPreDeploy(risky);
  assert.ok(['high', 'critical'].includes(r.level));
  assert.equal(r.recommendation.action, 'hold');
  assert.ok(r.successProbability < 40, `got ${r.successProbability}`);
  assert.ok(r.cons.some((c) => /Destructive database migration/.test(c)));
  assert.ok(r.mitigations.some((m) => /expand\/contract/.test(m)));
  assert.equal(r.factors[0].id, 'migration');
});

test('docker findings raise risk; failed history lowers success', () => {
  const base = assessPreDeploy(safe);
  const withDocker = assessPreDeploy(safe, undefined, { critical: 2, high: 3 });
  assert.ok(withDocker.riskScore > base.riskScore);
  const bad = assessPreDeploy(safe, { total: 10, succeeded: 3, recent: ['failed', 'rolled_back', 'failed'] });
  assert.ok(bad.successProbability < base.successProbability);
});

test('late-Friday timing is penalised using the tz offset', () => {
  const r = assessPreDeploy({ ...safe, scheduledAt: '2026-11-06T10:30:00Z', tzOffsetMinutes: -330 }); // 16:00 IST on a Friday
  assert.ok(r.factors.some((f) => f.id === 'timing' && f.points > 0));
});

test('live assessment: healthy samples lower risk and allow switch', () => {
  const pre = assessPreDeploy({ ...safe, scheduledAt: undefined, testsPassRate: 85, rollbackPlan: false, monitoring: false });
  const samples = Array.from({ length: 6 }, (_, i) => ({ at: i, errorRate: 0.2, p95Ms: 210, cpuPct: 40, memPct: 50, healthy: true }));
  const live = assessLive(pre, samples, { errorRate: 0.3, p95Ms: 200 });
  assert.ok(live.riskScore < pre.riskScore);
  assert.equal(live.verdict, 'healthy');
  assert.equal(live.recommendation.action, 'switch');
});

test('live assessment: error spike triggers rollback verdict', () => {
  const pre = assessPreDeploy(safe);
  const samples = Array.from({ length: 4 }, () => ({ errorRate: 7.5, p95Ms: 900, healthy: false }));
  const live = assessLive(pre, samples, { errorRate: 0.3, p95Ms: 200 });
  assert.equal(live.verdict, 'critical');
  assert.equal(live.recommendation.action, 'rollback');
  assert.ok(live.successProbability < 40);
});

test('no samples yet means waiting', () => {
  assert.equal(assessLive(assessPreDeploy(safe), []).verdict, 'waiting');
});

test('history summary', () => {
  const h = summarizeHistory([{ status: 'live' }, { status: 'failed' }, { status: 'planned' }, { status: 'live' }]);
  assert.deepEqual([h.total, h.succeeded, h.rate], [3, 2, 67]);
});
