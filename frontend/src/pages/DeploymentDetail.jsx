import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import DeploymentForm, { toForm } from '../components/DeploymentForm.jsx';
import { RiskGauge, Sparkline, levelColor } from '../components/Charts.jsx';
import { Loading, Modal, PageHead, confirmAction } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { fmtDateTime, timeAgo } from '../lib/format.js';

const statusText = (s) => s.replace('_', ' ');
const POLL = { deploying: 3000, verifying: 3000, live: 8000 };

function BlueGreen({ d }) {
  const { activeColor: from, targetColor: to, status, version } = d;
  const roles = {};
  if (status === 'live') { roles[to] = { tag: 'LIVE', note: `Running ${version}`, traffic: 100, live: true }; roles[from] = { tag: 'STANDBY', note: 'Previous version — ready for instant rollback', traffic: 0 }; }
  else {
    roles[from] = { tag: 'LIVE', note: 'Serving production traffic', traffic: 100, live: true };
    const tag = { planned: 'PLANNED', deploying: 'DEPLOYING', verifying: 'VERIFYING', rolled_back: 'ROLLED BACK', failed: 'FAILED', cancelled: 'CANCELLED' }[status];
    roles[to] = { tag, note: ['rolled_back', 'failed', 'cancelled'].includes(status) ? `${version} is not receiving traffic` : `New version ${version} (no traffic yet)`, traffic: 0 };
  }
  const Env = ({ color }) => (
    <div className={`env ${color} ${roles[color].live ? 'is-live' : ''}`}>
      <h4>{color}<span className={`pill ${roles[color].live ? 'live' : ''}`}>{roles[color].tag}</span></h4>
      <div className="traffic">{roles[color].traffic}%<span className="muted small" style={{ fontWeight: 400 }}> traffic</span></div>
      <div className="muted small" style={{ marginTop: 6 }}>{roles[color].note}</div>
    </div>
  );
  return (
    <div className="bg-visual">
      <Env color="blue" />
      <div className="switchline"><div className="arrow">{status === 'live' ? (to === 'green' ? '→' : '←') : '⇄'}</div>{status === 'live' ? 'cut over' : 'router'}</div>
      <Env color="green" />
    </div>
  );
}

export default function DeploymentDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaces, toast } = useApp();
  const [d, setD] = useState(null);
  
  const [token, setToken] = useState(location.state?.ingestToken || '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [showInt, setShowInt] = useState(!!location.state?.ingestToken);
  const [forceOpen, setForceOpen] = useState(false);
  const [reason, setReason] = useState('');
  const timer = useRef(null);

  const load = useCallback(async () => {
    try { const r = await api.get(`/deployments/${id}`); setD(r.deployment); } catch (e) { toast(e.message, 'error'); navigate('/deployments'); }
  }, [id, navigate, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    clearInterval(timer.current);
    const ms = d && POLL[d.status];
    if (ms) timer.current = setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => clearInterval(timer.current);
  }, [d?.status, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const ws = workspaces.find((w) => w.id === d?.workspace);
  const canAct = ws && ws.myRole !== 'viewer';
  const isAdmin = ws && ['owner', 'admin'].includes(ws.myRole);

  async function act(action, extra = {}) {
    setBusy(action);
    try { const r = await api.post(`/deployments/${id}/transition`, { action, ...extra }); setD(r.deployment); setForceOpen(false); setReason(''); toast(`Deployment ${statusText(r.deployment.status)}`, 'success'); }
    catch (e) { toast(e.message, 'error'); if (action === 'switch' && /Risk is/.test(e.message) && isAdmin) setForceOpen(true); }
    finally { setBusy(''); }
  }
  async function sample(kind) {
    const base = d.baseline || {};
    const p95 = base.p95Ms || 220; const r = (a, b) => a + Math.random() * (b - a);
    const body = { healthy: true, rps: Math.round(r(40, 90)), cpuPct: Math.round(r(30, 55)), memPct: Math.round(r(40, 60)), errorRate: +r(0.05, 0.4).toFixed(2), p95Ms: Math.round(p95 * r(0.9, 1.1)) };
    if (kind === 'degraded') Object.assign(body, { errorRate: +r(2, 3.5).toFixed(2), p95Ms: Math.round(p95 * r(1.8, 2.4)), cpuPct: Math.round(r(78, 92)), memPct: Math.round(r(80, 92)) });
    if (kind === 'failing') Object.assign(body, { healthy: false, errorRate: +r(6, 15).toFixed(2), p95Ms: Math.round(p95 * r(3, 5)), cpuPct: Math.round(r(92, 99)), memPct: Math.round(r(90, 98)) });
    try { const r2 = await api.post(`/deployments/${id}/metrics`, body); setD(r2.deployment); } catch (e) { toast(e.message, 'error'); }
  }
  async function save(payload) { const r = await api.patch(`/deployments/${id}`, payload); setD(r.deployment); setEditing(false); toast('Prediction updated', 'success'); }
  async function rotate() { try { const r = await api.post(`/deployments/${id}/rotate-token`); setToken(r.ingestToken); setShowInt(true); } catch (e) { toast(e.message, 'error'); } }
  async function remove() { if (!confirmAction('Delete this deployment record?')) return; try { await api.del(`/deployments/${id}`); navigate('/deployments'); } catch (e) { toast(e.message, 'error'); } }
  async function askAi() { setBusy('ai'); try { const r = await api.post(`/deployments/${id}/reassess-ai`); setD(r.deployment); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); } }

  if (!d) return <Loading />;
  const pre = d.assessment; const live = d.liveAssessment?.samples ? d.liveAssessment : null; const a = live || pre;
  const samples = d.samples || [];
  const col = (k) => samples.map((s) => s[k] ?? null);
  const ai = a.ai || pre.ai;
  const url = `${window.location.origin}/api`;
  const tk = token || '<INGEST_TOKEN>';
  const pending = ['planned', 'deploying', 'verifying'].includes(d.status);

  return (
    <>
      <PageHead title={`${d.name} ${d.version}`} subtitle={`${ws?.name || 'Workspace'} · ${d.environment} · ${d.strategy}`}>
        <span className={`pill ${d.status}`} style={{ fontSize: 13 }}>{statusText(d.status)}</span>
        <Link className="btn" to="/deployments">All deployments</Link>
      </PageHead>

      {canAct && (
        <div className="card" style={{ marginBottom: 16 }}><div className="card-body row wrap">
          {d.status === 'planned' && <><button className="btn primary" disabled={!!busy} onClick={() => act('start')}>Start deployment</button><button className="btn" onClick={() => act('verify')} disabled={!!busy}>Idle colour is up — begin verification</button></>}
          {d.status === 'deploying' && <button className="btn primary" disabled={!!busy} onClick={() => act('verify')}>New colour is up — begin verification</button>}
          {['deploying', 'verifying'].includes(d.status) && <button className="btn primary" disabled={!!busy} onClick={() => act('switch')}>Switch traffic to {d.targetColor}</button>}
          {['deploying', 'verifying', 'live'].includes(d.status) && <button className="btn danger" disabled={!!busy} onClick={() => confirmAction(`Roll back to ${d.activeColor}?`) && act('rollback')}>Roll back</button>}
          {['planned', 'deploying', 'verifying'].includes(d.status) && <button className="btn" onClick={() => act('fail')} disabled={!!busy}>Mark failed</button>}
          {d.status === 'planned' && <button className="btn ghost" onClick={() => act('cancel')}>Cancel</button>}
          <span className="spacer" />
          {pending && <button className="btn" onClick={() => setEditing(true)}>Update inputs</button>}
          <button className="btn" onClick={() => setShowInt((v) => !v)}>Pipeline integration</button>
          {isAdmin && <button className="btn ghost danger" onClick={remove}>Delete</button>}
        </div></div>
      )}

      <div className="card" style={{ marginBottom: 16 }}><div className="card-head"><h3>Blue / green environments</h3></div><div className="card-body"><BlueGreen d={d} /></div></div>

      <div className="dash-grid" style={{ marginBottom: 16 }}>
        <div className={`card lvl-${a.level}`}><div className="card-head"><h3>AI risk prediction</h3><span className="muted small">{live ? `Live · ${live.samples} samples` : 'Pre-deploy estimate'}</span></div>
          <div className="card-body">
            <div className="grid-2" style={{ alignItems: 'center' }}>
              <div><RiskGauge score={a.riskScore} level={a.level} /><div style={{ textAlign: 'center' }}><span className="pill lvl">{a.level} risk</span></div></div>
              <div><div className="big-stat" style={{ color: levelColor(a.level) }}>{a.successProbability}%</div><div className="muted">predicted success rate</div>
                <p className="muted small" style={{ marginTop: 10 }}>Planned estimate: risk {pre.riskScore}, success {pre.successProbability}%. Confidence: {pre.confidence}.{pre.historyUsed?.deployments ? ` Calibrated with ${pre.historyUsed.deployments} past deployment(s).` : ' No deployment history yet.'}</p></div>
            </div>
            <div className="reco" style={{ marginTop: 14 }}><b>{(live?.verdict || 'pre-deploy').replace('-', ' ')}</b> — {a.recommendation.text}</div>
            {a.mitigations?.length > 0 && <div style={{ marginTop: 12 }}><b className="small">Reduce the risk</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{a.mitigations.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          </div></div>

        <div className="card"><div className="card-head"><h3>Why this score</h3></div><div className="card-body">
          {pre.factors.slice(0, 9).map((f) => (
            <div className="factor" key={f.id} title={f.detail}><span>{f.label}</span>
              <span className="fbar"><i style={{ left: f.points > 0 ? '50%' : `${50 + (f.points / 26) * 50}%`, width: `${Math.min(50, (Math.abs(f.points) / 26) * 50)}%`, background: f.points > 0 ? 'var(--danger)' : 'var(--ok)' }} /></span>
              <b style={{ color: f.points > 0 ? 'var(--danger)' : 'var(--ok)', textAlign: 'right' }}>{f.points > 0 ? '+' : ''}{f.points}</b></div>))}
          <p className="muted small" style={{ marginTop: 8 }}>Transparent rule-based scoring blended with your workspace's deployment history. Hover a row for details.</p>
        </div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}><div className="card-head"><h3>Expected pros &amp; cons</h3>
        <button className="btn sm" disabled={busy === 'ai' || !canAct} onClick={askAi}>{busy === 'ai' ? 'Asking AI…' : 'Refresh AI insight'}</button></div>
        <div className="card-body">
          {ai?.summary && <p style={{ marginBottom: 12 }}>🤖 {ai.summary} <span className="muted small">({ai.model})</span></p>}
          {ai?.error && <p className="muted small" style={{ marginBottom: 10 }}>AI insight unavailable ({ai.error}). Rule-based analysis is shown.</p>}
          {!ai && <p className="muted small" style={{ marginBottom: 10 }}>Rule-based analysis. Configure an AI model on the server (AI_API_URL / AI_MODEL) to add LLM insights.</p>}
          <div className="proscons">
            <div><h4 className="pro">Pros</h4><ul>{[...a.pros, ...(ai?.pros || []).map((x) => `🤖 ${x}`)].map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            <div><h4 className="con">Cons &amp; risks</h4><ul>{[...a.cons, ...(ai?.cons || []).map((x) => `🤖 ${x}`), ...(ai?.risks || []).map((x) => `🤖 Watch: ${x}`)].map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          </div>
        </div></div>

      <div className="dash-grid" style={{ marginBottom: 16 }}>
        <div className="card"><div className="card-head"><h3>Live health of {d.targetColor}</h3><span className="muted small">{pending || d.status === 'live' ? `auto-refreshing` : 'final'}</span></div><div className="card-body">
          {samples.length === 0 ? <p className="muted">No health samples yet. Start the deployment and run the deploy script (or add test samples below).</p> : (
            <div className="spark-grid">
              {[['errorRate', 'Error rate %', '#ef4444', 10], ['p95Ms', 'p95 latency ms', '#6366f1'], ['cpuPct', 'CPU %', '#0ea5e9', 100], ['memPct', 'Memory %', '#a855f7', 100]].map(([k, label, color, max]) => {
                const v = col(k); const last = [...v].reverse().find((x) => x != null);
                return <div className="spark" key={k}><div className="muted small">{label}</div><div className="v">{last ?? '—'}</div><Sparkline values={v} color={color} max={max} /></div>;
              })}
            </div>)}
          {canAct && ['deploying', 'verifying', 'live'].includes(d.status) && (
            <div className="row wrap"><span className="muted small">Add a test sample:</span>
              <button className="btn sm" onClick={() => sample('healthy')}>Healthy</button><button className="btn sm" onClick={() => sample('degraded')}>Degraded</button><button className="btn sm danger" onClick={() => sample('failing')}>Failing</button></div>)}
        </div></div>
        <div className="card"><div className="card-head"><h3>Signals</h3></div><div className="card-body">
          {!live ? <p className="muted">Signals appear once health samples arrive.</p> : live.signals.map((s) => <div className="signal" key={s.label}><span>{s.label}</span><span className={`s-${s.status}`}>{s.value}</span></div>)}
        </div></div>
      </div>

      {showInt && (
        <div className="card" style={{ marginBottom: 16 }}><div className="card-head"><h3>Pipeline integration</h3>{isAdmin && <button className="btn sm" onClick={rotate}>Generate new token</button>}</div><div className="card-body stack">
          <p className="muted small">Your deploy script or CI posts health samples here and asks the AI gate before switching traffic. The ingest token is shown only once — store it as a CI secret.</p>
          {token ? <div className="link-box"><input readOnly value={token} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={() => navigator.clipboard?.writeText(token)}>Copy</button></div> : <p className="small">Token hidden. {isAdmin ? 'Generate a new one (the old one stops working).' : 'Ask a workspace admin.'}</p>}
          <div className="code-block">{`# Run the bundled blue/green script (see deploy/README.md)
export TASKFLOW_API=${url}
export TASKFLOW_DEPLOYMENT_ID=${d.id}
export TASKFLOW_INGEST_TOKEN=${tk}
./deploy/deploy.sh ${d.version}

# Or call the API yourself
curl -X POST $TASKFLOW_API/deployments/${d.id}/ingest \\
  -H "X-Ingest-Token: ${tk}" -H "Content-Type: application/json" \\
  -d '{"type":"metrics","errorRate":0.3,"p95Ms":210,"cpuPct":41,"memPct":55,"healthy":true}'

curl -H "X-Ingest-Token: ${tk}" $TASKFLOW_API/deployments/${d.id}/gate`}</div>
        </div></div>
      )}

      <div className="card"><div className="card-head"><h3>Timeline</h3></div><div className="card-body">
        <ul className="timeline">{[...(d.events || [])].reverse().map((e, i) => <li key={i}><b>{e.actor}</b> {e.message} <span className="muted small">· {timeAgo(e.at)}</span></li>)}</ul>
        {d.changelog && <><b className="small">Release notes</b><p style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{d.changelog}</p></>}
        <p className="muted small" style={{ marginTop: 8 }}>Created {fmtDateTime(d.createdAt)}{d.switchedAt ? ` · switched ${fmtDateTime(d.switchedAt)}` : ''}</p>
      </div></div>

      {editing && <DeploymentForm mode="edit" initial={d} workspaces={workspaces} onClose={() => setEditing(false)} onSubmit={save} />}
      {forceOpen && (
        <Modal title="Override the risk gate?" narrow onClose={() => setForceOpen(false)}
          footer={<><button className="btn" onClick={() => setForceOpen(false)}>Keep holding</button><button className="btn danger" onClick={() => act('switch', { force: true, reason })}>Switch anyway</button></>}>
          <p>The AI gate recommends against switching production traffic right now. Only continue if you accept the risk.</p>
          <label className="field" style={{ marginTop: 12 }}>Reason (recorded in the timeline)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
        </Modal>
      )}
    </>
  );
}
