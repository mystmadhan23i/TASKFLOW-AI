import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Loading, Modal, PriorityPill, StatusPill, confirmAction } from './ui.jsx';
import Icon from './Icon.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { PRIORITIES, STATUSES, fmtDateTime, fmtSize, timeAgo, toInputDate } from '../lib/format.js';

const blank = (workspace = '') => ({ title: '', description: '', status: 'todo', priority: 'medium', dueDate: '', workspace, project: '', assignee: '', labels: '' });

export default function TaskModal({ taskId, defaults = {}, onClose, onChanged }) {
  const { workspaces, toast } = useApp();
  const { user } = useAuth();
  const [detail, setDetail] = useState(null);
  const [perms, setPerms] = useState({ canEdit: true, canDelete: true });
  const [form, setForm] = useState(blank(defaults.workspace || ''));
  const [projects, setProjects] = useState([]);
  const [tab, setTab] = useState('details');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const fileRef = useRef(null);
  const isNew = !taskId;

  const load = useCallback(async (resetForm = true) => {
    const d = await api.get(`/tasks/${taskId}`);
    setDetail(d.task);
    setPerms(d.permissions);
    if (!resetForm) return;
    const t = d.task;
    setForm({
      title: t.title, description: t.description || '', status: t.status, priority: t.priority, dueDate: toInputDate(t.dueDate),
      workspace: t.workspace?.id || '', project: t.project?.id || '', assignee: t.assignee?.id || '', labels: (t.labels || []).join(', ')
    });
  }, [taskId]);

  useEffect(() => { if (taskId) load().catch((e) => { toast(e.message, 'error'); onClose(); }); }, [taskId, load, toast, onClose]);
  useEffect(() => { api.get('/projects').then((d) => setProjects(d.projects)).catch(() => {}); }, []);

  const ws = workspaces.find((w) => w.id === form.workspace);
  const members = ws?.members || [];
  const wsProjects = useMemo(() => projects.filter((p) => p.workspace === form.workspace && !p.archived), [projects, form.workspace]);
  const writable = workspaces.filter((w) => w.myRole !== 'viewer');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    const payload = {
      title: form.title, description: form.description, status: form.status, priority: form.priority,
      dueDate: form.dueDate || null, project: form.project || null, assignee: form.assignee || null,
      labels: form.labels.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10)
    };
    try {
      if (isNew) await api.post('/tasks', { ...payload, workspace: form.workspace || null });
      else await api.patch(`/tasks/${taskId}`, payload);
      toast(isNew ? 'Task created' : 'Task saved', 'success');
      onChanged();
      if (isNew) onClose(); else load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function remove() {
    if (!confirmAction('Delete this task permanently?')) return;
    try { await api.del(`/tasks/${taskId}`); toast('Task deleted'); onChanged(); onClose(); } catch (err) { toast(err.message, 'error'); }
  }
  async function addComment(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    try { await api.post(`/tasks/${taskId}/comments`, { text: comment }); setComment(''); await load(false); onChanged(); } catch (err) { toast(err.message, 'error'); }
  }
  async function delComment(id) {
    try { await api.del(`/tasks/${taskId}/comments/${id}`); await load(false); } catch (err) { toast(err.message, 'error'); }
  }
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { await api.upload(`/tasks/${taskId}/attachments`, file); toast(`Uploaded ${file.name}`, 'success'); await load(false); onChanged(); } catch (err) { toast(err.message, 'error'); }
  }
  async function delFile(id) {
    if (!confirmAction('Remove this attachment?')) return;
    try { await api.del(`/tasks/${taskId}/attachments/${id}`); await load(false); onChanged(); } catch (err) { toast(err.message, 'error'); }
  }

  const readOnly = !isNew && !perms.canEdit;
  const tabs = isNew ? null : (
    <div className="tabs" role="tablist">
      {[['details', 'Details'], ['comments', `Comments (${detail?.comments?.length || 0})`], ['files', `Files (${detail?.attachments?.length || 0})`], ['activity', 'Activity']].map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
  );

  return (
    <Modal title={isNew ? 'New task' : 'Task'} onClose={onClose} tabs={tabs}
      footer={tab === 'details' && (
        <>
          {!isNew && perms.canDelete && <button type="button" className="btn danger" onClick={remove}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {!readOnly && <button form="task-form" className="btn primary" disabled={saving}>{saving ? 'Saving…' : isNew ? 'Create task' : 'Save changes'}</button>}
        </>
      )}>
      {!isNew && !detail ? <Loading /> : (
        <>
          {tab === 'details' && (
            <form id="task-form" className="stack" onSubmit={save}>
              <label className="field">Title
                <input required maxLength={160} value={form.title} onChange={set('title')} disabled={readOnly} autoFocus placeholder="e.g. Fix failing Docker build on CI" />
              </label>
              <label className="field">Description
                <textarea value={form.description} onChange={set('description')} disabled={readOnly} placeholder="Context, requirements, acceptance criteria…" rows={4} />
              </label>
              <div className="grid-3">
                <label className="field">Status<select value={form.status} onChange={set('status')} disabled={readOnly}>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
                <label className="field">Priority<select value={form.priority} onChange={set('priority')} disabled={readOnly}>{PRIORITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
                <label className="field">Due date<input type="date" value={form.dueDate} onChange={set('dueDate')} disabled={readOnly} /></label>
              </div>
              <div className="grid-3">
                <label className="field">Workspace
                  <select value={form.workspace} onChange={(e) => setForm((f) => ({ ...f, workspace: e.target.value, project: '', assignee: '' }))} disabled={!isNew}>
                    <option value="">Personal (private)</option>
                    {(isNew ? writable : workspaces).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <label className="field">Project
                  <select value={form.project} onChange={set('project')} disabled={readOnly || !form.workspace}>
                    <option value="">No project</option>{wsProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="field">Assignee
                  <select value={form.assignee} onChange={set('assignee')} disabled={readOnly || !form.workspace}>
                    <option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === user.id ? ' (you)' : ''}</option>)}
                  </select>
                </label>
              </div>
              <label className="field">Labels (comma separated)<input value={form.labels} onChange={set('labels')} disabled={readOnly} placeholder="docker, backend, urgent-fix" /></label>
              {error && <p className="error-text" role="alert">{error}</p>}
              {readOnly && <p className="muted small">You have view-only access to this task.</p>}
            </form>
          )}

          {tab === 'comments' && (
            <div>
              {detail.comments.length === 0 && <p className="muted">No comments yet. Start the conversation.</p>}
              {detail.comments.map((c) => (
                <div className="comment" key={c.id}>
                  <Avatar name={c.author?.name || '?'} small />
                  <div className="body"><b>{c.author?.name || 'Former member'}</b> <span className="muted small">{timeAgo(c.createdAt)}</span><div>{c.text}</div></div>
                  {(c.author?.id === user.id || ws?.myRole === 'owner' || ws?.myRole === 'admin') && <button className="icon-btn" aria-label="Delete comment" onClick={() => delComment(c.id)}><Icon name="trash" size={15} /></button>}
                </div>
              ))}
              {perms.canEdit && (
                <form className="stack" style={{ marginTop: 12 }} onSubmit={addComment}>
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" maxLength={4000} rows={3} />
                  <div className="row"><span className="spacer" /><button className="btn primary" disabled={!comment.trim()}>Post comment</button></div>
                </form>
              )}
            </div>
          )}

          {tab === 'files' && (
            <div>
              {detail.attachments.length === 0 && <p className="muted" style={{ marginBottom: 12 }}>No files attached.</p>}
              {detail.attachments.map((a) => (
                <div className="file-row" key={a.id}>
                  <Icon name="clip" />
                  <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{a.originalName}</div><div className="muted small">{fmtSize(a.size)} · {fmtDateTime(a.createdAt)}</div></div>
                  <button className="btn sm" onClick={() => api.download(`/tasks/${taskId}/attachments/${a.id}`, a.originalName).catch((e) => toast(e.message, 'error'))}><Icon name="download" size={14} />Download</button>
                  {perms.canEdit && <button className="icon-btn" aria-label="Remove file" onClick={() => delFile(a.id)}><Icon name="trash" size={15} /></button>}
                </div>
              ))}
              {perms.canEdit && (<><input ref={fileRef} type="file" className="hidden" onChange={upload} /><button className="btn" onClick={() => fileRef.current.click()}><Icon name="upload" size={15} />Upload file</button><p className="muted small" style={{ marginTop: 8 }}>Up to 10 MB. Scripts and executables are blocked.</p></>)}
            </div>
          )}

          {tab === 'activity' && (
            <ul className="timeline">
              {[...detail.activity].reverse().map((a, i) => <li key={i}><b>{a.actor?.name || 'Someone'}</b> {a.action} · {timeAgo(a.at)}</li>)}
            </ul>
          )}
          {tab === 'details' && !isNew && detail && (
            <div className="row wrap muted small" style={{ marginTop: 14 }}>
              <StatusPill value={detail.status} /><PriorityPill value={detail.priority} />
              <span>Created by {detail.createdBy?.name} · {fmtDateTime(detail.createdAt)}</span>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
