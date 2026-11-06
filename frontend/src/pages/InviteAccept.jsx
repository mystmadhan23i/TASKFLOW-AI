import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { Spinner } from '../components/ui.jsx';

export default function InviteAccept() {
  const { token } = useParams();
  const { refreshWorkspaces, toast } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api.post('/invitations/accept', { token })
      .then(async (d) => { await refreshWorkspaces(); toast(d.message, 'success'); navigate('/team', { replace: true }); })
      .catch((e) => setError(e.message));
  }, [token, navigate, refreshWorkspaces, toast]);

  return (
    <div className="card" style={{ maxWidth: 480, margin: '60px auto' }}>
      <div className="card-body stack" style={{ textAlign: 'center' }}>
        {error ? (<><h3>Couldn't accept invitation</h3><p className="error-text">{error}</p><Link className="btn" to="/">Back to dashboard</Link></>)
          : (<><Spinner /><p>Joining workspace…</p></>)}
      </div>
    </div>
  );
}
