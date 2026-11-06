import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DeploymentForm from '../components/DeploymentForm.jsx';
import { Empty, Loading, PageHead } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { fmtDateTime } from '../lib/format.js';

export const statusText = (s) => s.replace('_', ' ');

export default function Deployments() {
  const { workspaces, toast } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);
  const [wsFilter, setWsFilter] = useState('');
  const writable = workspaces.filter((w) => w.myRole !== 'viewer');
  const wsName = Object.fromEntries(workspaces.map((w) => [w.id, w.name]));

  const load = useCallback(() => api.get(`/deployments${wsFilter ? `?workspace=${wsFilter}` : ''}`).then(setData).catch((e) => { toast(e.message, 'error'); setData({ deployments: [], stats: { total: 0 } }); }), [wsFilter, toast]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function create(payload) {
    const d = await api.post('/deployments', payload);
    toast('Deployment planned', 'success');
    navigate(`/deployments/${d.deployment.id}`, { state: { ingestToken: d.ingestToken } });
  }

  if (!data) return <Loading />;
  const { deployments, stats } = data;
  const live = deployments.filter((d) => ['deploying', 'verifying'].includes(d.status)).length;

  return (
    <>
      <PageHead title="Deployments" subtitle="Blue/green releases with AI-assisted risk prediction and live health verification.">
        <select value={wsFilter} onChange={(e) => setWsFilter(e.target.value)} style={{ width: 'auto' }} aria-label="Workspace"><option value="">All workspaces</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <button className="btn primary" disabled={!writable.length} onClick={() => setCreating(true)}><Icon name="rocket" size={15} />Plan deployment</button>
      </PageHead>
      <div className="stats">
        <div className="card stat"><div className="label">Historical success rate</div><div className="value">{stats.rate == null ? '—' : `${stats.rate}%`}</div></div>
        <div className="card stat"><div className="label">Finished deployments</div><div className="value">{stats.total}</div></div>
        <div className="card stat"><div className="label">In progress</div><div className="value">{live}</div></div>
        <div className="card stat"><div className="label">Total planned</div><div className="value">{deployments.length}</div></div>
      </div>
      {deployments.length === 0 ? (
        <div className="card"><Empty title="No deployments yet">{writable.length ? 'Plan your first blue/green release to get a risk and success-rate prediction before you deploy.' : <>Deployments belong to a workspace. <Link to="/team">Create or join one</Link> first.</>}</Empty></div>
      ) : (
        <div className="card">
          {deployments.map((d) => {
            const a = d.liveAssessment?.samples ? d.liveAssessment : d.assessment;
            return (
              <Link key={d.id} to={`/deployments/${d.id}`} className="dep-row">
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap"><b>{d.name}</b><span className="pill brand">{d.version}</span><span className={`pill ${d.status}`}>{statusText(d.status)}</span><span className="pill">{d.strategy}</span><span className="pill">{d.environment}</span></div>
                  <div className="muted small" style={{ marginTop: 4 }}>{wsName[d.workspace]} · {d.activeColor} → {d.targetColor} · {fmtDateTime(d.createdAt)}</div>
                </div>
                {a && <div className={`row lvl-${a.level}`}><div style={{ textAlign: 'right' }}><div style={{ fontWeight: 800 }}>{a.successProbability}% <span className="muted small" style={{ fontWeight: 400 }}>success</span></div><span className="pill lvl">{a.level} risk · {a.riskScore}</span></div></div>}
              </Link>
            );
          })}
        </div>
      )}
      {creating && <DeploymentForm workspaces={writable} onClose={() => setCreating(false)} onSubmit={create} />}
    </>
  );
}
