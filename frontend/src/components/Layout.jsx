import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { Avatar } from './ui.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/format.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/tasks', label: 'Tasks', icon: 'tasks' },
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/team', label: 'Team', icon: 'team' },
  { to: '/deployments', label: 'Deployments', icon: 'rocket' }
];
const TITLES = { '/': 'Dashboard', '/tasks': 'Tasks', '/projects': 'Projects', '/team': 'Team', '/deployments': 'Deployments', '/analyzer': 'Docker AI Analyzer', '/notifications': 'Notifications', '/settings': 'Settings' };

function Bell() {
  const { unread, setUnread, refreshUnread } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function toggle() {
    if (!open) { const d = await api.get('/notifications').catch(() => ({ notifications: [] })); setItems(d.notifications.slice(0, 8)); }
    setOpen(!open);
  }
  async function go(n) {
    setOpen(false);
    if (!n.readAt) { await api.patch(`/notifications/${n.id}/read`).catch(() => {}); refreshUnread(); }
    navigate(n.link || '/notifications');
  }
  async function readAll() { await api.post('/notifications/read-all'); setUnread(0); setItems((l) => l.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() }))); }

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn" onClick={toggle} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><Icon name="bell" size={20} />{unread > 0 && <span className="badge-count">{unread > 99 ? '99+' : unread}</span>}</button>
      {open && (
        <div className="dropdown">
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <strong>Notifications</strong><span className="spacer" />
            <button className="btn sm ghost" onClick={readAll}>Mark all read</button>
          </div>
          {items.length === 0 && <div className="empty small">You're all caught up.</div>}
          {items.map((n) => (
            <a key={n.id} className={`item ${n.readAt ? '' : 'unread'}`} href={n.link || '/notifications'} onClick={(e) => { e.preventDefault(); go(n); }}>
              <strong style={{ fontSize: 13 }}>{n.title}</strong>
              <div className="muted small">{n.message}</div>
              <div className="muted small">{timeAgo(n.createdAt)}</div>
            </a>
          ))}
          <a className="item small" style={{ textAlign: 'center' }} href="/notifications" onClick={(e) => { e.preventDefault(); setOpen(false); navigate('/notifications'); }}>View all</a>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { unread, myInvitations } = useApp();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  const title = TITLES[pathname] || (pathname.startsWith('/deployments/') ? 'Deployment' : 'TaskFlow');

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><span className="logo"><Icon name="check" size={20} /></span>TaskFlow</div>
        <div className="nav-label">Workspace</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} />{n.label}
            {n.to === '/team' && myInvitations.length > 0 && <span className="badge-count">{myInvitations.length}</span>}
          </NavLink>
        ))}
        <div className="nav-label">Intelligence</div>
        <NavLink to="/analyzer" className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}><Icon name="ai" />Docker AI Analyzer</NavLink>
        <div className="nav-label">Account</div>
        <NavLink to="/notifications" className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}><Icon name="bell" />Notifications{unread > 0 && <span className="badge-count">{unread}</span>}</NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}><Icon name="settings" />Settings</NavLink>
        <div className="sidebar-foot">
          <Avatar name={user.name} />
          <div className="who"><strong>{user.name}</strong><small>{user.email}</small></div>
          <button className="icon-btn" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
        </div>
      </aside>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <h1>{title}</h1><span className="spacer" />
          <Bell />
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
