import { useState } from 'react';
import { PageHead } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';

export default function Settings() {
  const { user, setUser } = useAuth();
  const { toast } = useApp();
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('tf_theme') || 'system'; } catch { return 'system'; } });

  async function saveProfile(e) {
    e.preventDefault();
    try { const d = await api.patch('/auth/me', { name }); setUser(d.user); toast('Profile updated', 'success'); } catch (err) { toast(err.message, 'error'); }
  }
  async function changePw(e) {
    e.preventDefault();
    try { await api.post('/auth/change-password', pw); setPw({ currentPassword: '', newPassword: '' }); toast('Password changed', 'success'); } catch (err) { toast(err.message, 'error'); }
  }
  function applyTheme(v) {
    setTheme(v);
    try { v === 'system' ? localStorage.removeItem('tf_theme') : localStorage.setItem('tf_theme', v); } catch { /* ignore */ }
    v === 'system' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', v);
  }

  return (
    <>
      <PageHead title="Settings" subtitle="Manage your profile, security and appearance." />
      <div className="dash-grid">
        <div className="stack">
          <form className="card" onSubmit={saveProfile}><div className="card-head"><h3>Profile</h3></div><div className="card-body stack">
            <label className="field">Full name<input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">Email<input value={user.email} disabled /></label>
            <div><button className="btn primary">Save profile</button></div></div></form>
          <form className="card" onSubmit={changePw}><div className="card-head"><h3>Change password</h3></div><div className="card-body stack">
            <label className="field">Current password<input type="password" required autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></label>
            <label className="field">New password (min 10 characters)<input type="password" required minLength={10} autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></label>
            <div><button className="btn primary">Update password</button></div></div></form>
        </div>
        <div className="card"><div className="card-head"><h3>Appearance</h3></div><div className="card-body">
          <div className="seg" role="group" aria-label="Theme">{['system', 'light', 'dark'].map((t) => <button key={t} className={theme === t ? 'active' : ''} onClick={() => applyTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div></div></div>
      </div>
    </>
  );
}
