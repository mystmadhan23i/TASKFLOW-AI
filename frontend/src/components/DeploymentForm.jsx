import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui.jsx';
import { RiskGauge } from './Charts.jsx';
import { api } from '../lib/api.js';

const num = (v) => (v === '' || v == null ? undefined : Number(v));
const tri = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined);
const triOf = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export function toForm(d) {
  const i = d?.input || {};
  return {
    workspace: d?.workspace || '', name: d?.name || '', version: d?.version || '', environment: d?.environment || 'production', strategy: d?.strategy || 'blue-green',
    activeColor: d?.activeColor || 'blue', scheduledAt: localInput(d?.scheduledAt), changelog: d?.changelog || '',
    linesChanged: i.linesChanged ?? '', filesChanged: i.filesChanged ?? '', dbMigration: i.dbMigration || 'none', migrationReversible: i.migrationReversible !== false,
    dependencyChanges: i.dependencyChanges || 'none', configChanges: !!i.configChanges, testsPassRate: i.testsPassRate ?? '', coverage: i.coverage ?? '',
    rollbackPlan: triOf(i.rollbackPlan), standbyReady: triOf(i.standbyReady), monitoring: triOf(i.monitoring), featureFlags: !!i.featureFlags, hotfix: !!i.hotfix,
    baseErr: d?.baseline?.errorRate ?? '', baseP95: d?.baseline?.p95Ms ?? '', artifactName: d?.artifactName || '', artifactText: ''
  };
}

export function toPayload(f, { edit = false } = {}) {
  const p = {
    changelog: f.changelog, linesChanged: num(f.linesChanged), filesChanged: num(f.filesChanged), dbMigration: f.dbMigration,
    migrationReversible: f.dbMigration === 'destructive' ? f.migrationReversible : undefined, dependencyChanges: f.dependencyChanges,
    configChanges: f.configChanges, testsPassRate: f.testsPassRate === '' ? null : Number(f.testsPassRate), coverage: f.coverage === '' ? null : Number(f.coverage),
    rollbackPlan: tri(f.rollbackPlan), standbyReady: tri(f.standbyReady), monitoring: tri(f.monitoring), featureFlags: f.featureFlags, hotfix: f.hotfix,
    scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null, tzOffsetMinutes: new Date().getTimezoneOffset(),
    baseline: { errorRate: num(f.baseErr), p95Ms: num(f.baseP95) }
  };
  if (f.artifactText.trim()) { p.artifactText = f.artifactText; p.artifactName = f.artifactName || 'Dockerfile'; }
  if (!edit) Object.assign(p, { workspace: f.workspace, name: f.name, version: f.version, environment: f.environment, strategy: f.strategy, activeColor: f.activeColor });
  return JSON.parse(JSON.stringify(p));
}

export default function DeploymentForm({ mode = 'create', initial, workspaces, onSubmit, onClose }) {
  const [f, setF] = useState(() => ({ ...toForm(initial), workspace: initial?.workspace || workspaces[0]?.id || '' }));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = mode === 'edit';
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const previewPayload = useMemo(() => JSON.stringify(toPayload(f, { edit: false })), [f]);
  useEffect(() => {
    const t = setTimeout(() => {
      const body = JSON.parse(previewPayload);
      delete body.name; delete body.version; if (!body.workspace) delete body.workspace;
      api.post('/deployments/predict', body).then((d) => setPreview(d.assessment)).catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  }, [previewPayload]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { await onSubmit(toPayload(f, { edit })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const triSel = (k, label) => (
    <label className="field">{label}<select value={f[k]} onChange={set(k)}><option value="">Not specified</option><option value="yes">Yes</option><option value="no">No</option></select></label>
  );

  return (
    <Modal title={edit ? 'Update inputs & re-predict' : 'Plan a deployment'} onClose={onClose} wide
      footer={<><span className="muted small" style={{ marginRight: 'auto' }}>{error && <span className="error-text">{error}</span>}</span>
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="dep-form" disabled={busy}>{busy ? 'Saving…' : edit ? 'Save & re-predict' : 'Create & predict'}</button></>}>
      <form id="dep-form" className="form-cols" onSubmit={submit}>
        <div className="stack">
          {!edit && (
            <fieldset className="group"><legend>Release</legend>
              <div className="grid-2">
                <label className="field">Workspace<select required value={f.workspace} onChange={set('workspace')}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
                <label className="field">Service name<input required minLength={2} value={f.name} onChange={set('name')} placeholder="taskflow-api" /></label>
              </div>
              <div className="grid-3">
                <label className="field">Version / tag<input required value={f.version} onChange={set('version')} placeholder="v2.4.0" /></label>
                <label className="field">Environment<select value={f.environment} onChange={set('environment')}><option value="production">Production</option><option value="staging">Staging</option></select></label>
                <label className="field">Strategy<select value={f.strategy} onChange={set('strategy')}><option value="blue-green">Blue / green</option><option value="canary">Canary</option><option value="rolling">Rolling</option><option value="recreate">Recreate</option></select></label>
              </div>
              <div className="grid-2">
                <label className="field">Colour live right now<select value={f.activeColor} onChange={set('activeColor')}><option value="blue">Blue (deploy to green)</option><option value="green">Green (deploy to blue)</option></select></label>
                <label className="field">Planned cutover time<input type="datetime-local" value={f.scheduledAt} onChange={set('scheduledAt')} /></label>
              </div>
            </fieldset>
          )}
          <fieldset className="group"><legend>Change profile</legend>
            <div className="grid-3">
              <label className="field">Lines changed<input type="number" min="0" value={f.linesChanged} onChange={set('linesChanged')} /></label>
              <label className="field">Files changed<input type="number" min="0" value={f.filesChanged} onChange={set('filesChanged')} /></label>
              <label className="field">Dependency changes<select value={f.dependencyChanges} onChange={set('dependencyChanges')}><option value="none">None</option><option value="minor">Minor / patch</option><option value="major">Major upgrade</option></select></label>
            </div>
            <div className="grid-3">
              <label className="field">Database migration<select value={f.dbMigration} onChange={set('dbMigration')}><option value="none">None</option><option value="additive">Additive (backwards compatible)</option><option value="destructive">Destructive (drop / rename)</option></select></label>
              <label className="field">Tests passing (%)<input type="number" min="0" max="100" value={f.testsPassRate} onChange={set('testsPassRate')} placeholder="unknown" /></label>
              <label className="field">Coverage (%)<input type="number" min="0" max="100" value={f.coverage} onChange={set('coverage')} /></label>
            </div>
            <div className="row wrap">
              {f.dbMigration === 'destructive' && <label className="check-line"><input type="checkbox" checked={f.migrationReversible} onChange={set('migrationReversible')} />Migration is reversible</label>}
              <label className="check-line"><input type="checkbox" checked={f.configChanges} onChange={set('configChanges')} />Env / config changes</label>
              <label className="check-line"><input type="checkbox" checked={f.featureFlags} onChange={set('featureFlags')} />Behind feature flags</label>
              <label className="check-line"><input type="checkbox" checked={f.hotfix} onChange={set('hotfix')} />Hotfix</label>
            </div>
          </fieldset>
          <fieldset className="group"><legend>Readiness</legend>
            <div className="grid-3">{triSel('rollbackPlan', 'Rollback plan rehearsed?')}{triSel('standbyReady', 'Idle colour verified?')}{triSel('monitoring', 'Monitoring & alerts ready?')}</div>
            <div className="grid-2">
              <label className="field">Baseline error rate of live colour (%)<input type="number" step="0.01" min="0" value={f.baseErr} onChange={set('baseErr')} placeholder="e.g. 0.4" /></label>
              <label className="field">Baseline p95 latency (ms)<input type="number" min="0" value={f.baseP95} onChange={set('baseP95')} placeholder="e.g. 240" /></label>
            </div>
          </fieldset>
          <fieldset className="group"><legend>Notes &amp; Docker files (optional)</legend>
            <label className="field">Changelog / release notes<textarea rows={3} maxLength={4000} value={f.changelog} onChange={set('changelog')} placeholder="What changes in this release?" /></label>
            <label className="field">Paste Dockerfile or docker-compose to include its findings
              <textarea className="code-area" style={{ minHeight: 110 }} spellCheck={false} value={f.artifactText} onChange={set('artifactText')} placeholder="FROM node:20 …" /></label>
            {f.artifactText && <label className="field">File name<input value={f.artifactName} onChange={set('artifactName')} placeholder="Dockerfile" /></label>}
          </fieldset>
        </div>
        <aside><div className="preview-box" aria-live="polite">
          <b>Live prediction</b>
          {!preview ? <p className="muted small" style={{ marginTop: 8 }}>Calculating…</p> : (
            <div className={`lvl-${preview.level}`}>
              <RiskGauge score={preview.riskScore} level={preview.level} />
              <div className="row" style={{ justifyContent: 'center', marginTop: 4 }}><span className="pill lvl">{preview.level} risk</span></div>
              <div style={{ textAlign: 'center', margin: '10px 0' }}><div className="big-stat">{preview.successProbability}%</div><div className="muted small">predicted success</div></div>
              <div className="reco small">{preview.recommendation.text}</div>
              <p className="muted small" style={{ marginTop: 8 }}>Confidence: {preview.confidence}. Updates as you type.</p>
            </div>)}
        </div></aside>
      </form>
    </Modal>
  );
}
