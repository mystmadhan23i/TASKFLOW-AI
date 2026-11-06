import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { useAuth } from '../lib/AuthContext.jsx';

export default function Login() {
  const { user, login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const from = useLocation().state?.from || '/';
  if (user) return <Navigate to={from} replace />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'login') await login({ email: form.email, password: form.password });
      else await register(form);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0 }}><span className="logo"><Icon name="check" size={20} /></span>TaskFlow</div>
        <h1>Turn your tasks into Process
          Process into Success...
        </h1>
        
      </section>
      <section className="auth-panel">
        <form className="card auth-card stack" onSubmit={submit}>
          <div><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p className="muted">{mode === 'login' ? 'Sign in to continue to TaskFlow.' : 'Start managing work with your team.'}</p></div>
          {mode === 'register' && <label className="field">Full name<input required minLength={2} maxLength={80} value={form.name} onChange={set('name')} autoComplete="name" /></label>}
          <label className="field">Email<input type="email" required value={form.email} onChange={set('email')} autoComplete="email" /></label>
          <label className="field">Password<input type="password" required minLength={mode === 'register' ? 10 : 1} value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'register' && <span className="small muted" style={{ fontWeight: 400 }}>At least 10 characters.</span>}
          </label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="btn ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? 'New to TaskFlow? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}
