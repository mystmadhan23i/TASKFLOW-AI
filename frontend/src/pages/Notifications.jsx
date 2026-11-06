import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Loading, PageHead } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { timeAgo } from '../lib/format.js';

export default function Notifications() {
  const { refreshUnread, toast } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(() => api.get(`/notifications${onlyUnread ? '?unread=true' : ''}`).then((d) => setItems(d.notifications)).catch((e) => toast(e.message, 'error')), [onlyUnread, toast]);
  useEffect(() => { load(); }, [load]);

  async function open(n) {
    if (!n.readAt) { await api.patch(`/notifications/${n.id}/read`).catch(() => {}); refreshUnread(); }
    if (n.link) navigate(n.link); else load();
  }
  async function readAll() { await api.post('/notifications/read-all'); refreshUnread(); load(); }
  async function remove(e, n) { e.stopPropagation(); await api.del(`/notifications/${n.id}`); refreshUnread(); load(); }

  return (
    <>
      <PageHead title="Notifications" subtitle="Assignments, comments, status changes and team activity.">
        <div className="seg"><button className={!onlyUnread ? 'active' : ''} onClick={() => setOnlyUnread(false)}>All</button><button className={onlyUnread ? 'active' : ''} onClick={() => setOnlyUnread(true)}>Unread</button></div>
        <button className="btn" onClick={readAll}>Mark all read</button>
      </PageHead>
      {items === null ? <Loading /> : items.length === 0 ? <div className="card"><Empty title="You're all caught up">New notifications will show up here.</Empty></div> : (
        <div className="card">
          {items.map((n) => (
            <div key={n.id} className="task-row" style={{ gridTemplateColumns: '14px 1fr auto', background: n.readAt ? 'transparent' : 'var(--brand-soft)' }} onClick={() => open(n)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(n)}>
              <i className="dot" style={{ background: n.readAt ? 'transparent' : 'var(--brand-2)' }} />
              <div><b>{n.title}</b><div className="muted">{n.message}</div></div>
              <div className="row"><span className="muted small">{timeAgo(n.createdAt)}</span><button className="btn sm ghost" onClick={(e) => remove(e, n)} aria-label="Dismiss">✕</button></div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
