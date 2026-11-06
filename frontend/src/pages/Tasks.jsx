import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Board, TaskList } from '../components/TaskViews.jsx';
import TaskModal from '../components/TaskModal.jsx';
import { Empty, Loading, PageHead } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { PRIORITIES, STATUSES } from '../lib/format.js';

const load = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

export default function Tasks() {
  const { workspaces, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState(null);
  const [projects, setProjects] = useState([]);
  const [view, setView] = useState(load('tf_view', 'list'));
  const [f, setF] = useState({ q: '', workspace: '', project: '', status: '', priority: '', scope: '', due: '', sort: 'recent' });
  const [q, setQ] = useState('');
  const openId = params.get('open');
  const creating = params.get('new') === '1';

  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, q })), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { api.get('/projects').then((d) => setProjects(d.projects)).catch(() => {}); }, []);

  const fetchTasks = useCallback(async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    try { setTasks((await api.get(`/tasks?${qs}`)).tasks); } catch (e) { toast(e.message, 'error'); setTasks([]); }
  }, [f, toast]);
  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const changeView = (v) => { setView(v); try { localStorage.setItem('tf_view', v); } catch { /* ignore */ } };
  const closeModal = useCallback(() => setParams({}, { replace: true }), [setParams]);
  const setFilter = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value, ...(k === 'workspace' ? { project: '' } : {}) }));

  async function setStatus(id, status) {
    const prev = tasks;
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, status } : t)));
    try { await api.patch(`/tasks/${id}`, { status }); fetchTasks(); } catch (e) { setTasks(prev); toast(e.message, 'error'); }
  }
  const toggle = (t) => setStatus(t.id, t.status === 'done' ? 'todo' : 'done');
  const move = (id, status) => { const t = tasks.find((x) => x.id === id); if (t && t.status !== status) setStatus(id, status); };

  const projectOptions = useMemo(() => projects.filter((p) => !f.workspace || p.workspace === f.workspace), [projects, f.workspace]);
  const hasFilters = f.q || f.workspace || f.project || f.status || f.priority || f.scope || f.due;

  return (
    <>
      <PageHead title="Tasks" subtitle="Plan, assign and track work across personal and team workspaces.">
        <div className="seg" role="group" aria-label="View">
          <button className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')}>List</button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => changeView('board')}>Board</button>
        </div>
        <button className="btn primary" onClick={() => setParams({ new: '1' })}><Icon name="plus" size={15} />New task</button>
      </PageHead>
      <div className="toolbar">
        <input type="search" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
        <select value={f.workspace} onChange={setFilter('workspace')} aria-label="Workspace"><option value="">All workspaces</option><option value="personal">Personal</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <select value={f.project} onChange={setFilter('project')} aria-label="Project"><option value="">All projects</option>{projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {view === 'list' && <select value={f.status} onChange={setFilter('status')} aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>}
        <select value={f.priority} onChange={setFilter('priority')} aria-label="Priority"><option value="">Any priority</option>{PRIORITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        <select value={f.scope} onChange={setFilter('scope')} aria-label="Ownership"><option value="">Everyone's</option><option value="mine">Assigned to me</option><option value="created">Created by me</option></select>
        <select value={f.due} onChange={setFilter('due')} aria-label="Due"><option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option></select>
        <select value={f.sort} onChange={setFilter('sort')} aria-label="Sort"><option value="recent">Recently updated</option><option value="created">Newest</option><option value="due">Due date</option></select>
        {hasFilters && <button className="btn ghost sm" onClick={() => { setQ(''); setF({ q: '', workspace: '', project: '', status: '', priority: '', scope: '', due: '', sort: 'recent' }); }}>Clear filters</button>}
      </div>
      {tasks === null ? <Loading /> : tasks.length === 0 ? (
        <div className="card"><Empty title={hasFilters ? 'No tasks match your filters' : 'No tasks yet'}>{hasFilters ? 'Try clearing a filter.' : 'Create a task to get started.'}</Empty></div>
      ) : view === 'list' ? <TaskList tasks={tasks} onOpen={(id) => setParams({ open: id })} onToggle={toggle} /> : <Board tasks={tasks} onOpen={(id) => setParams({ open: id })} onMove={move} />}
      {(openId || creating) && <TaskModal key={openId || 'new'} taskId={openId} defaults={{ workspace: f.workspace && f.workspace !== 'personal' ? f.workspace : '' }} onClose={closeModal} onChanged={fetchTasks} />}
    </>
  );
}
