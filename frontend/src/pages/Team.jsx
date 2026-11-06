import { useCallback, useEffect, useState } from 'react';
import { Avatar, Empty, Modal, PageHead, confirmAction } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { fmtDate } from '../lib/format.js';

const isAdmin = (r) => r === 'owner' || r === 'admin';

export default function Team() {
  const { user } = useAuth();
  const { workspaces, myInvitations, refreshWorkspaces, toast } = useApp();
  const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem('tf_ws') || ''; } catch { return ''; } });
  const [creating, setCreating] = useState(false);
  const [wsForm, setWsForm] = useState({ name: '', description: '' });
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [pending, setPending] = useState([]);
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState(false);

  const ws = workspaces.find((w) => w.id === selectedId) || workspaces[0];
  const select = (id) => { setSelectedId(id); setLink(''); try { localStorage.setItem('tf_ws', id); } catch { /* ignore */ } };

  const loadPending = useCallback(async () => {
    if (ws && isAdmin(ws.myRole)) setPending((await api.get(`/workspaces/${ws.id}/invitations`).catch(() => ({ invitations: [] }))).invitations);
    else setPending([]);
  }, [ws]);
  useEffect(() => { loadPending(); }, [loadPending]);

  const run = (fn, ok) => async (...args) => {
    try { await fn(...args); if (ok) toast(ok, 'success'); await refreshWorkspaces(); await loadPending(); } catch (e) { toast(e.message, 'error'); }
  };

  const createWs = run(async (e) => {
    e.preventDefault();
    const d = await api.post('/workspaces', wsForm);
    setCreating(false); setWsForm({ name: '', description: '' }); select(d.workspace.id);
  }, 'Workspace created');
  const saveWs = run(async (e) => { e.preventDefault(); await api.patch(`/workspaces/${ws.id}`, wsForm); setEditing(false); }, 'Workspace updated');
  const deleteWs = run(async () => { await api.del(`/workspaces/${ws.id}`); select(''); }, 'Workspace deleted');
  const sendInvite = run(async (e) => {
    e.preventDefault();
    const d = await api.post(`/workspaces/${ws.id}/invitations`, invite);
    setLink(d.invitation.acceptUrl); setInvite({ ...invite, email: '' });
  }, 'Invitation created');
  const revoke = run((id) => api.del(`/workspaces/${ws.id}/invitations/${id}`), 'Invitation revoked');
  const setRole = run((m, role) => api.patch(`/workspaces/${ws.id}/members/${m.userId}`, { role }), 'Role updated');
  const removeMember = run(async (m) => {
    const self = m.userId === user.id;
    if (!confirmAction(self ? `Leave ${ws.name}?` : `Remove ${m.name} from ${ws.name}?`)) return;
    await api.del(`/workspaces/${ws.id}/members/${m.userId}`);
  });
  const accept = run((i) => api.post(`/invitations/${i.id}/accept`), 'Invitation accepted');
  const decline = run((i) => api.post(`/invitations/${i.id}/decline`));

  return (
    <>
      <PageHead title="Team" subtitle="Workspaces, members, roles and invitations.">
        <button className="btn primary" onClick={() => { setWsForm({ name: '', description: '' }); setCreating(true); }}>New workspace</button>
      </PageHead>

      {myInvitations.map((i) => (
        <div className="banner" key={i.id}>
          <span style={{ flex: 1 }}><b>{i.invitedBy}</b> invited you to <b>{i.workspaceName}</b> as {i.role}.</span>
          <button className="btn sm primary" onClick={() => accept(i)}>Accept</button><button className="btn sm" onClick={() => decline(i)}>Decline</button>
        </div>
      ))}

      {workspaces.length === 0 ? (
        <div className="card"><Empty title="No workspaces yet">Create a workspace to collaborate with teammates. Your personal tasks stay private.</Empty></div>
      ) : (
        <>
          <div className="ws-grid" style={{ marginBottom: 18 }}>
            {workspaces.map((w) => (
              <div key={w.id} className={`card ws-card ${w.id === ws?.id ? 'active' : ''}`} onClick={() => select(w.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(w.id)}>
                <div className="row"><h3 style={{ flex: 1 }}>{w.name}</h3><span className="pill brand">{w.myRole}</span></div>
                <p className="muted small" style={{ margin: '6px 0 0' }}>{w.members.length} member{w.members.length === 1 ? '' : 's'}{w.description ? ` · ${w.description}` : ''}</p>
              </div>
            ))}
          </div>

          {ws && (
            <div className="dash-grid">
              <div className="card">
                <div className="card-head"><h3>Members of {ws.name}</h3>
                  <div className="row">
                    {isAdmin(ws.myRole) && <button className="btn sm" onClick={() => { setWsForm({ name: ws.name, description: ws.description }); setEditing(true); }}>Rename</button>}
                    {ws.myRole === 'owner' && <button className="btn sm danger" onClick={() => confirmAction(`Delete “${ws.name}” and ALL its projects and tasks? This cannot be undone.`) && deleteWs()}>Delete workspace</button>}
                  </div>
                </div>
                <div className="card-body" style={{ padding: '8px 0 0' }}>
                  {ws.members.map((m) => (
                    <div className="member" key={m.userId}>
                      <Avatar name={m.name} />
                      <div style={{ flex: 1, minWidth: 0 }}><b>{m.name}{m.userId === user.id && ' (you)'}</b><div className="muted small">{m.email}</div></div>
                      {m.role === 'owner' || !isAdmin(ws.myRole) || (ws.myRole === 'admin' && m.role === 'admin')
                        ? <span className="pill brand">{m.role}</span>
                        : <select value={m.role} onChange={(e) => setRole(m, e.target.value)} aria-label={`Role for ${m.name}`}>
                            {ws.myRole === 'owner' && <option value="admin">admin</option>}<option value="member">member</option><option value="viewer">viewer</option>
                          </select>}
                      {m.role !== 'owner' && (m.userId === user.id || (isAdmin(ws.myRole) && !(ws.myRole === 'admin' && m.role === 'admin'))) &&
                        <button className="btn sm ghost danger" onClick={() => removeMember(m)}>{m.userId === user.id ? 'Leave' : 'Remove'}</button>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="stack">
                {isAdmin(ws.myRole) ? (
                  <div className="card"><div className="card-head"><h3>Invite a teammate</h3></div><div className="card-body stack">
                    <form className="stack" onSubmit={sendInvite}>
                      <label className="field">Email<input type="email" required placeholder="teammate@company.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></label>
                      <label className="field">Role<select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                        {ws.myRole === 'owner' && <option value="admin">Admin — manage members and projects</option>}<option value="member">Member — create and edit tasks</option><option value="viewer">Viewer — read only</option></select></label>
                      <button className="btn primary">Create invitation</button>
                    </form>
                    {link && <div className="stack"><span className="small muted">Share this single-use link (valid 7 days). It only works for the invited email address.</span>
                      <div className="link-box"><input readOnly value={link} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied', 'success'))}>Copy</button></div></div>}
                    {pending.length > 0 && <div><b className="small">Pending invitations</b>{pending.map((p) => (
                      <div className="row" key={p.id} style={{ padding: '6px 0' }}><span style={{ flex: 1 }}>{p.email} <span className="muted small">· {p.role} · expires {fmtDate(p.expiresAt)}</span></span><button className="btn sm ghost danger" onClick={() => revoke(p.id)}>Revoke</button></div>))}</div>}
                  </div></div>
                ) : <div className="card"><div className="card-body muted">Only owners and admins can invite people. You are a {ws.myRole}.</div></div>}
                <div className="card"><div className="card-head"><h3>Roles</h3></div><div className="card-body small muted">
                  <p><b>Owner</b> — everything, including deleting the workspace.</p><p><b>Admin</b> — manage members, projects and all tasks.</p>
                  <p><b>Member</b> — create, edit and comment on tasks.</p><p><b>Viewer</b> — read-only access.</p></div></div>
              </div>
            </div>
          )}
        </>
      )}

      {(creating || editing) && (
        <Modal title={creating ? 'New workspace' : 'Edit workspace'} narrow onClose={() => { setCreating(false); setEditing(false); }}
          footer={<><button className="btn" onClick={() => { setCreating(false); setEditing(false); }}>Cancel</button><button className="btn primary" form="ws-form">Save</button></>}>
          <form id="ws-form" className="stack" onSubmit={creating ? createWs : saveWs}>
            <label className="field">Name<input required minLength={2} maxLength={100} value={wsForm.name} onChange={(e) => setWsForm({ ...wsForm, name: e.target.value })} autoFocus /></label>
            <label className="field">Description<textarea maxLength={500} value={wsForm.description} onChange={(e) => setWsForm({ ...wsForm, description: e.target.value })} /></label>
          </form>
        </Modal>
      )}
    </>
  );
}
