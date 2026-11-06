import { useState } from 'react';
import Icon from './Icon.jsx';
import { Avatar, PriorityPill, StatusPill } from './ui.jsx';
import { STATUSES, fmtDate, isOverdue } from '../lib/format.js';

function Meta({ task, showWorkspace }) {
  return (
    <div className="meta">
      {task.dueDate && <span className={`pill ${isOverdue(task) ? 'overdue' : ''}`}>{isOverdue(task) ? 'Overdue · ' : 'Due '}{fmtDate(task.dueDate)}</span>}
      {showWorkspace && <span>{task.workspace?.name || 'Personal'}</span>}
      {task.project && <span><i className="dot" style={{ background: task.project.color }} /> {task.project.name}</span>}
      {task.labels?.slice(0, 3).map((l) => <span className="pill brand" key={l}>{l}</span>)}
      {task.commentCount > 0 && <span>💬 {task.commentCount}</span>}
      {task.attachmentCount > 0 && <span>📎 {task.attachmentCount}</span>}
    </div>
  );
}

export function TaskList({ tasks, onOpen, onToggle }) {
  return (
    <div className="card">
      {tasks.map((t) => (
        <div className="task-row" key={t.id} onClick={() => onOpen(t.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}>
          <button className={`check ${t.status === 'done' ? 'on' : ''}`} aria-label={t.status === 'done' ? 'Mark as to do' : 'Mark as done'}
            onClick={(e) => { e.stopPropagation(); onToggle(t); }}>{t.status === 'done' && <Icon name="check" size={12} />}</button>
          <div style={{ minWidth: 0 }}>
            <div className={`task-title ${t.status === 'done' ? 'done' : ''}`}>{t.title}</div>
            <Meta task={t} showWorkspace />
          </div>
          <div className="row">
            <PriorityPill value={t.priority} /><StatusPill value={t.status} />
            {t.assignee ? <Avatar name={t.assignee.name} small /> : <span className="avatar sm" title="Unassigned">–</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Board({ tasks, onOpen, onMove }) {
  const [over, setOver] = useState('');
  return (
    <div className="board">
      {STATUSES.map((col) => {
        const items = tasks.filter((t) => t.status === col.value);
        return (
          <div key={col.value} className={`column ${over === col.value ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(col.value); }}
            onDragLeave={() => setOver('')}
            onDrop={(e) => { e.preventDefault(); setOver(''); const id = e.dataTransfer.getData('text/plain'); if (id) onMove(id, col.value); }}>
            <h4><span>{col.label}</span><span>{items.length}</span></h4>
            {items.map((t) => (
              <div key={t.id} className="kcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} onClick={() => onOpen(t.id)}>
                <div className={`task-title ${t.status === 'done' ? 'done' : ''}`}>{t.title}</div>
                <Meta task={t} />
                <div className="row" style={{ marginTop: 8 }}><PriorityPill value={t.priority} /><span className="spacer" />{t.assignee && <Avatar name={t.assignee.name} small />}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
