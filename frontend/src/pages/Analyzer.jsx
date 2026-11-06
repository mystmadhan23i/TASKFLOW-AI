import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Loading, PageHead, confirmAction } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { fmtDateTime } from '../lib/format.js';

const MAX = 60000;
const SEVS = ['critical', 'high', 'medium', 'low', 'info'];
const TYPE_LABEL = { dockerfile: 'Dockerfile', compose: 'Compose file', logs: 'Container logs', text: 'Text' };

const SAMPLES = {
  Dockerfile: ['Dockerfile', `FROM node:latest
ENV API_TOKEN=abc123456789
COPY . .
RUN npm install
RUN curl -fsSL https://example.com/install.sh | sh
EXPOSE 22 3000
CMD npm start`],
  'Compose file': ['docker-compose.yml', `version: "3.8"
services:
  db:
    image: postgres:latest
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: hunter2
  api:
    build: .
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - db`],
  'Container logs': ['container.log', `2026-11-04T10:01:12Z api | Error: connect ECONNREFUSED 172.18.0.2:27017
2026-11-04T10:01:13Z api | MongoServerSelectionError: connection refused
2026-11-04T10:02:40Z docker | Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:3000 failed: port is already allocated
2026-11-04T10:05:00Z worker exited with code 137
2026-11-04T10:05:00Z kernel: Out of memory: Killed process 4242 (node)`]
};

function Report({ a, onTask }) {
  const download = () => {
    const lines = [`TaskFlow Docker AI analysis — ${a.filename}`, `Type: ${TYPE_LABEL[a.detectedType]} · Provider: ${a.provider} · ${fmtDateTime(a.createdAt)}`, '', a.summary, '', 'FINDINGS',
      ...a.findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.line ? ` (line ${f.line})` : ''}\n   ${f.detail}\n   Fix: ${f.fix}`), '', 'NEXT STEPS', ...a.nextSteps.map((s, i) => `${i + 1}. ${s}`), '', a.aiNote];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: `analysis-${a.filename.replace(/\W+/g, '_')}.txt` }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="card"><div className="card-head"><div><h3>{a.filename}</h3><span className="muted small">{TYPE_LABEL[a.detectedType]} · {a.provider === 'rules' ? 'Rule engine' : `AI (${a.provider.replace('ai:', '')})`}</span></div>
      <button className="btn sm" onClick={download}><Icon name="download" size={14} />Report</button></div>
      <div className="card-body">
        <p>{a.summary}</p>
        <div className="sev-row">{SEVS.filter((s) => a.counts?.[s]).map((s) => <span key={s} className={`pill ${s === 'critical' ? 'urgent' : s}`}>{a.counts[s]} {s}</span>)}</div>
        {a.redactions > 0 && <p className="small muted" style={{ marginBottom: 10 }}>🔒 {a.redactions} secret-like value(s) were redacted before any AI call.</p>}
        {a.findings.length === 0 && <Empty title="No issues detected">Nothing matched the known Docker patterns.</Empty>}
        {a.findings.map((f, i) => (
          <div className={`finding ${f.severity}`} key={`${f.id}-${i}`}>
            <div className="row"><span className={`pill ${f.severity === 'critical' ? 'urgent' : f.severity}`}>{f.severity}</span><b style={{ flex: 1 }}>{f.title}</b>{f.line && <span className="muted small">line {f.line}</span>}</div>
            <div className="detail">{f.detail}</div>
            {f.fix && <div className="fix"><b>Fix:</b> {f.fix}</div>}
            {['critical', 'high', 'medium'].includes(f.severity) && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => onTask(f, a)}><Icon name="plus" size={13} />Create task</button>}
          </div>
        ))}
        {a.nextSteps?.length > 0 && <><h4 style={{ margin: '14px 0 6px' }}>Recommended next steps</h4><ol style={{ margin: 0, paddingLeft: 20 }}>{a.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ol></>}
        {a.aiNote && <p className="small muted" style={{ marginTop: 14 }}>{a.aiNote} Always verify commands before running them.</p>}
      </div>
    </div>
  );
}

export default function Analyzer() {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const [status, setStatus] = useState({ aiConfigured: false });
  const fileRef = useRef(null);

  const loadHistory = useCallback(() => api.get('/analysis').then((d) => setHistory(d.analyses)).catch(() => setHistory([])), []);
  useEffect(() => { loadHistory(); api.get('/analysis/status').then(setStatus).catch(() => {}); }, [loadHistory]);

  async function analyze(e) {
    e.preventDefault();
    setBusy(true); setResult(null);
    try { const d = await api.post('/analysis', { text, filename: filename || 'pasted-text' }); setResult(d.analysis); loadHistory(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  async function loadFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('Choose a text file under 2 MB', 'error');
    const content = await file.text();
    if (content.includes('\u0000')) return toast('This looks like a binary file. Upload a text file.', 'error');
    setText(content.slice(0, MAX)); setFilename(file.name);
    if (content.length > MAX) toast(`Only the first ${MAX.toLocaleString()} characters were loaded`);
  }
  async function openHistory(id) { try { setResult((await api.get(`/analysis/${id}`)).analysis); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { toast(e.message, 'error'); } }
  async function removeHistory(id) { if (!confirmAction('Delete this report?')) return; await api.del(`/analysis/${id}`); if (result?.id === id) setResult(null); loadHistory(); }
  async function createTask(f, a) {
    try {
      await api.post('/tasks', { title: `Docker: ${f.title}`.slice(0, 160), priority: f.severity === 'critical' ? 'urgent' : f.severity === 'high' ? 'high' : 'medium', labels: ['docker'],
        description: `${f.detail}\n\nSuggested fix: ${f.fix}\n\nSource: ${a.filename}${f.line ? ` (line ${f.line})` : ''}` });
      toast('Personal task created', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <PageHead title="Docker AI Analyzer" subtitle="Paste a Dockerfile, Compose file or container logs to find problems and get safe fixes.">
        <span className={`pill ${status.aiConfigured ? 'brand' : ''}`}>{status.aiConfigured ? 'AI model connected' : 'Rule engine (no AI model configured)'}</span>
      </PageHead>
      <div className="analyzer">
        <form className="card" onSubmit={analyze}><div className="card-body stack">
          <div className="row wrap">{Object.entries(SAMPLES).map(([label, [name, body]]) => <button type="button" key={label} className="btn sm" onClick={() => { setText(body); setFilename(name); setResult(null); }}>Sample {label}</button>)}
            <span className="spacer" /><input ref={fileRef} type="file" className="hidden" accept=".txt,.log,.yml,.yaml,.json,.md,.sh,.conf,.env,.dockerfile,Dockerfile" onChange={loadFile} />
            <button type="button" className="btn sm" onClick={() => fileRef.current.click()}><Icon name="upload" size={14} />Upload file</button></div>
          <label className="field">File name (helps detect the type)<input value={filename} onChange={(e) => setFilename(e.target.value)} maxLength={150} placeholder="Dockerfile, docker-compose.yml, build.log…" /></label>
          <label className="field">Content
            <textarea className="code-area" required spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX} placeholder="Paste Dockerfile, docker-compose.yml, or docker/container logs here…" />
          </label>
          <div className="row"><span className="small muted">{text.length.toLocaleString()} / {MAX.toLocaleString()} characters · secrets are redacted before any AI call</span><span className="spacer" />
            <button className="btn primary" disabled={busy || !text.trim()}>{busy ? 'Analyzing…' : 'Analyze'}</button></div>
        </div></form>
        <div className="stack">
          {busy && <div className="card"><Loading /></div>}
          {result && <Report a={result} onTask={createTask} />}
          <div className="card"><div className="card-head"><h3>Previous analyses</h3></div><div className="card-body" style={{ paddingTop: 8 }}>
            {history === null ? <Loading /> : history.length === 0 ? <p className="muted">Your saved reports will appear here.</p> : history.map((h) => (
              <div className="row" key={h.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <button className="btn ghost sm" style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => openHistory(h.id)}>{h.filename}</button>
                <span className="muted small">{TYPE_LABEL[h.detectedType]} · {fmtDateTime(h.createdAt)}</span>
                <button className="icon-btn" aria-label="Delete report" onClick={() => removeHistory(h.id)}><Icon name="trash" size={15} /></button>
              </div>))}
          </div></div>
        </div>
      </div>
    </>
  );
}
