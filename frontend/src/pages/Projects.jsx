import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Loading, Modal, PageHead, confirmAction } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#64748b'];

export default function Projects() {
  const { workspaces, toast } = useApp();
  const [projects, setProjects] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/projects').then((d) => setProjects(d.projects)).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);

  const wsById = Object.fromEntries(workspaces.map((w) => [w.id, w]));
  const canWrite = workspaces.filter((w) => w.myRole !== 'viewer');

  async function save(e) {
    e.preventDefault(); setError('');
    try {
      if (form.id) await api.patch(`/projects/${form.id}`, { name: form.name, description: form.description, color: form.color });
      else await api.post('/projects', { workspace: form.workspace, name: form.name, description: form.description, color: form.color });
      setForm(null); toast('Project saved', 'success'); load();
    } catch (err) { setError(err.message); }
  }
  async function archive(p) { await api.patch(`/projects/${p.id}`, { archived: !p.archived }).catch((e) => toast(e.message, 'error')); load(); }
  async function remove(p) {
    if (!confirmAction(`Delete project “${p.name}”? Its tasks will be kept without a project.`)) return;
    try { await api.del(`/projects/${p.id}`); load(); } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Projects" subtitle="Group related tasks inside a team workspace.">
        <button className="btn primary" disabled={!canWrite.length} onClick={() => setForm({ workspace: canWrite[0]?.id, name: '', description: '', color: COLORS[0] })}>New project</button>
      </PageHead>
      {projects === null ? <Loading /> : projects.length === 0 ? (
        <div className="card"><Empty title="No projects yet">{workspaces.length ? 'Create a project to organise tasks.' : <>Projects live inside a workspace. <Link to="/team">Create a workspace</Link> first.</>}</Empty></div>
      ) : (
        <div className="ws-grid">
          {projects.map((p) => {
            const pct = p.taskCount ? Math.round((p.doneCount / p.taskCount) * 100) : 0;
            const role = wsById[p.workspace]?.myRole;
            return (
              <div className="card ws-card" key={p.id} style={{ cursor: 'default', opacity: p.archived ? 0.6 : 1 }}>
                <div className="row"><i className="dot" style={{ background: p.color }} /><h3 style={{ flex: 1 }}>{p.name}</h3>{p.archived && <span className="pill">Archived</span>}</div>
                <p className="muted small" style={{ margin: '4px 0 10px' }}>{wsById[p.workspace]?.name}</p>
                <p style={{ minHeight: 40 }}>{p.description || <span className="muted">No description</span>}</p>
                <div className="bar" style={{ margin: '12px 0 6px' }}><i style={{ width: `${pct}%` }} /></div>
                <div className="muted small">{p.doneCount} of {p.taskCount} tasks done</div>
                <div className="row" style={{ marginTop: 12 }}>
                  <Link className="btn sm" to={`/tasks`} onClick={() => { try { localStorage.setItem('tf_view', 'board'); } catch { /* ignore */ } }}>Open tasks</Link>
                  {role && role !== 'viewer' && <button className="btn sm" onClick={() => setForm({ ...p })}>Edit</button>}
                  {role && role !== 'viewer' && <button className="btn sm ghost" onClick={() => archive(p)}>{p.archived ? 'Restore' : 'Archive'}</button>}
                  {(role === 'owner' || role === 'admin') && <button className="btn sm ghost danger" onClick={() => remove(p)}>Delete</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {form && (
        <Modal title={form.id ? 'Edit project' : 'New project'} narrow onClose={() => setForm(null)}
          footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn primary" form="project-form">Save</button></>}>
          <form id="project-form" className="stack" onSubmit={save}>
            {!form.id && <label className="field">Workspace<select value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })}>{canWrite.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
            <label className="field">Name<input required minLength={2} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></label>
            <label className="field">Description<textarea maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <div className="row wrap" role="radiogroup" aria-label="Color">{COLORS.map((c) => <button type="button" key={c} aria-label={c} aria-checked={form.color === c} role="radio" onClick={() => setForm({ ...form, color: c })} style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: form.color === c ? '3px solid var(--text)' : '2px solid transparent' }} />)}</div>
            {error && <p className="error-text" role="alert">{error}</p>}
          </form>
        </Modal>
      )}
    </>
  );
}
