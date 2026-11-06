import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Loading, PageHead, PriorityPill, StatusPill } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { STATUSES, PRIORITIES, fmtDate, timeAgo } from '../lib/format.js';

function Bars({ data, defs }) {
  const max = Math.max(1, ...Object.values(data));
  return defs.map((d) => (
    <div className="bar-row" key={d.value}><span>{d.label}</span><div className="bar"><i style={{ width: `${(data[d.value] / max) * 100}%` }} /></div><b>{data[d.value]}</b></div>
  ));
}

export default function Dashboard() {
  const { user } = useAuth();
  const { toast } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/dashboard').then(setD).catch((e) => toast(e.message, 'error')); }, [toast]);
  if (!d) return <Loading />;
  const t = d.totals;
  const hour = new Date().getHours();
  return (
    <>
      <PageHead title={`${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user.name.split(' ')[0]}`} subtitle="Here is what's happening across your work.">
        <Link className="btn" to="/analyzer">Analyze Docker file</Link><Link className="btn primary" to="/tasks?new=1">New task</Link>
      </PageHead>
      <div className="stats">
        <div className="card stat"><div className="label">Total tasks</div><div className="value">{t.total}</div></div>
        <div className="card stat"><div className="label">Assigned to me</div><div className="value">{t.assignedToMe}</div></div>
        <div className={`card stat ${t.overdue ? 'alert' : ''}`}><div className="label">Overdue</div><div className="value">{t.overdue}</div></div>
        <div className="card stat"><div className="label">Due today</div><div className="value">{t.dueToday}</div></div>
        <div className="card stat"><div className="label">Done this week</div><div className="value">{t.doneThisWeek}</div></div>
        <div className="card stat"><div className="label">Completion</div><div className="value">{t.completionRate}%</div></div>
      </div>
      <div className="dash-grid">
        <div className="stack">
          <div className="card"><div className="card-head"><h3>Upcoming deadlines</h3><Link to="/tasks" className="small">All tasks</Link></div>
            <div className="card-body">
              {d.upcoming.length === 0 ? <Empty title="Nothing due soon">Tasks with due dates will appear here.</Empty> : d.upcoming.map((x) => (
                <div className="row" key={x.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <Link to={`/tasks?open=${x.id}`} style={{ color: 'var(--text)', fontWeight: 600, flex: 1 }}>{x.title}</Link>
                  <span className="muted small">{fmtDate(x.dueDate)}</span><PriorityPill value={x.priority} />
                </div>
              ))}
            </div>
          </div>
          <div className="card"><div className="card-head"><h3>Recent activity</h3></div>
            <div className="card-body">
              {d.recent.length === 0 ? <Empty title="No tasks yet">Create your first task to get started.</Empty> : d.recent.map((x) => (
                <div className="row" key={x.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <Link to={`/tasks?open=${x.id}`} style={{ color: 'var(--text)', flex: 1 }}>{x.title}</Link>
                  <StatusPill value={x.status} /><span className="muted small">{timeAgo(x.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="card"><div className="card-head"><h3>By status</h3></div><div className="card-body"><Bars data={d.status} defs={STATUSES} /></div></div>
          <div className="card"><div className="card-head"><h3>Open tasks by priority</h3></div><div className="card-body"><Bars data={d.priority} defs={PRIORITIES} /></div></div>
          <div className="card"><div className="card-body row"><div style={{ flex: 1 }}><b>Docker AI analyses</b><div className="muted small">{t.analyses} saved report(s)</div></div><Link className="btn" to="/analyzer">Open</Link></div></div>
        </div>
      </div>
    </>
  );
}
