import { useEffect } from 'react';
import Icon from './Icon.jsx';
import { initials, priorityLabel, statusLabel } from '../lib/format.js';

export function Avatar({ name, small }) {
  return <span className={`avatar ${small ? 'sm' : ''}`} title={name}>{initials(name)}</span>;
}

export const StatusPill = ({ value }) => <span className={`pill ${value}`}>{statusLabel(value)}</span>;
export const PriorityPill = ({ value }) => <span className={`pill ${value}`}>{priorityLabel(value)}</span>;

export function Modal({ title, onClose, children, footer, narrow, wide, tabs }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${narrow ? 'narrow' : ''} ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {tabs}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children }) {
  return <div className="empty"><h4>{title}</h4><p>{children}</p></div>;
}

export function Spinner() { return <span className="spinner" role="status" aria-label="Loading" />; }

export function Loading() { return <div className="empty"><Spinner /></div>; }

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="page-head">
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <div className="row wrap">{children}</div>
    </div>
  );
}

export function confirmAction(message) {
  return window.confirm(message);
}
