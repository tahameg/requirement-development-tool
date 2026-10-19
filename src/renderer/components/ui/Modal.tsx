import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Button, IconButton } from './primitives.js';

export function Modal({ title, eyebrow, icon, onClose, children, footer, width = 'md', className, labelledBy = 'modal-title', dismissable = true }: {
  title: React.ReactNode; eyebrow?: React.ReactNode; icon?: IconName; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; labelledBy?: string; dismissable?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) {
      node.showModal();
      // React's autoFocus fires before showModal() and is lost, and showModal() would focus the close button.
      // Put the caret in the first usable field, else on the first footer button (Cancel).
      const field = node.querySelector<HTMLElement>('.modal-body :is(input, textarea, select):not(:disabled):not([type=hidden])');
      (field ?? node.querySelector<HTMLElement>('.modal-foot button:not(:disabled)'))?.focus();
    }
    return () => { if (node?.open) node.close(); };
  }, []);
  return <dialog ref={dialog} className={`modal modal-${width}${className ? ` ${className}` : ''}`} aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); if (dismissable) onClose(); }}>
    <header className="modal-head">
      {icon && <span className="modal-icon"><Icon name={icon} size={20} /></span>}
      <div className="modal-titles">{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2 id={labelledBy}>{title}</h2></div>
      {dismissable && <IconButton icon="close" label="Close" onClick={onClose} />}
    </header>
    <div className="modal-body">{children}</div>
    {footer && <footer className="modal-foot">{footer}</footer>}
  </dialog>;
}

interface ConfirmOptions { title: string; body?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'danger' | 'primary'; icon?: IconName; }
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async options => window.confirm(options.title));
export const useConfirm = () => useContext(ConfirmContext);
interface Toast { id: number; tone: 'info' | 'ok' | 'danger' | 'accent'; title: string; body?: React.ReactNode; icon?: IconName; sticky?: boolean }
type Notify = (toast: Omit<Toast, 'id'>) => void;
const ToastContext = createContext<Notify>(() => {});
export const useToast = () => useContext(ToastContext);

/** One host for promise-based confirms and transient toasts, so no screen reaches for window.confirm. */
export function OverlayHost({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const confirm = useCallback<Confirm>(options => new Promise(resolve => setPending({ ...options, resolve })), []);
  const notify = useCallback<Notify>(toast => {
    const id = ++next.current;
    setToasts(list => [...list.slice(-3), { ...toast, id }]);
    if (!toast.sticky) setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 6000);
  }, []);
  const settle = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  return <ConfirmContext.Provider value={confirm}><ToastContext.Provider value={notify}>
    {children}
    {pending && <Modal title={pending.title} icon={pending.icon ?? (pending.tone === 'danger' ? 'warning' : 'info')} width="sm" onClose={() => settle(false)} labelledBy="confirm-title" className={`confirm confirm-${pending.tone ?? 'primary'}`}
      footer={<><Button onClick={() => settle(false)} autoFocus>{pending.cancelLabel ?? 'Cancel'}</Button><Button tone={pending.tone ?? 'primary'} onClick={() => settle(true)}>{pending.confirmLabel ?? 'Continue'}</Button></>}>
      {pending.body}
    </Modal>}
    <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast toast-${t.tone}`} role="status">
      <Icon name={t.icon ?? (t.tone === 'danger' ? 'warning' : t.tone === 'ok' ? 'check' : 'info')} size={18} />
      <div><strong>{t.title}</strong>{t.body && <div className="toast-body">{t.body}</div>}</div>
      <IconButton icon="close" label="Dismiss" onClick={() => setToasts(list => list.filter(x => x.id !== t.id))} />
    </div>)}</div>
  </ToastContext.Provider></ConfirmContext.Provider>;
}
