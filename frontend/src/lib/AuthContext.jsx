import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!getToken());

  const logout = useCallback(() => { setToken(null); setUser(null); }, []);

  useEffect(() => {
    if (!getToken()) return;
    api.get('/auth/me').then((d) => setUser(d.user)).catch(() => setToken(null)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    window.addEventListener('tf:unauthorized', logout);
    return () => window.removeEventListener('tf:unauthorized', logout);
  }, [logout]);

  const authenticate = useCallback(async (mode, payload) => {
    const d = await api.post(`/auth/${mode}`, payload);
    setToken(d.token);
    setUser(d.user);
  }, []);

  const value = useMemo(() => ({ user, setUser, loading, logout, login: (p) => authenticate('login', p), register: (p) => authenticate('register', p) }), [user, loading, logout, authenticate]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
