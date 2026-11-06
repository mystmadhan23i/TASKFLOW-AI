import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './AuthContext.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function AppProvider({ children }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [myInvitations, setMyInvitations] = useState([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const toast = useCallback((message, type = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 3500);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    const [w, i] = await Promise.all([api.get('/workspaces'), api.get('/invitations/mine')]);
    setWorkspaces(w.workspaces);
    setMyInvitations(i.invitations);
    return w.workspaces;
  }, []);

  const refreshUnread = useCallback(() => api.get('/notifications/unread-count').then((d) => setUnread(d.unread)).catch(() => {}), []);

  useEffect(() => {
    if (!user) return undefined;
    refreshWorkspaces().catch(() => {});
    refreshUnread();
    const timer = setInterval(refreshUnread, 30000);
    const onFocus = () => refreshUnread();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user, refreshWorkspaces, refreshUnread]);

  const value = useMemo(() => ({ workspaces, myInvitations, unread, setUnread, toast, refreshWorkspaces, refreshUnread }), [workspaces, myInvitations, unread, toast, refreshWorkspaces, refreshUnread]);

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}
      </div>
    </AppContext.Provider>
  );
}
