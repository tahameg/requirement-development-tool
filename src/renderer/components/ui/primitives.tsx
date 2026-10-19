import React from 'react';
import { Icon, type IconName } from './Icon.js';

type Tone = 'default' | 'primary' | 'danger' | 'ghost';
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; tone?: Tone; kbd?: string };
export function Button({ icon, tone = 'default', kbd, className, children, type = 'button', ...rest }: ButtonProps) {
  // Labels collapse to icons in tight toolbars; keep the words as a tooltip.
  return <button type={type} className={`btn btn-${tone}${className ? ` ${className}` : ''}`} title={typeof children === 'string' ? children : undefined} {...rest}>
    {icon && <Icon name={icon} />}{children && <span>{children}</span>}{kbd && <kbd>{kbd}</kbd>}
  </button>;
}
/** Square icon-only button; the label doubles as tooltip and accessible name. */
export function IconButton({ icon, label, tone = 'ghost', className, type = 'button', ...rest }: Omit<ButtonProps, 'children'> & { icon: IconName; label: string }) {
  return <button type={type} className={`btn btn-icon btn-${tone}${className ? ` ${className}` : ''}`} aria-label={label} title={label} {...rest}><Icon name={icon} /></button>;
}
/** Groups related actions; separate groups so different jobs never sit side by side. */
export function ButtonGroup({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div className="btn-group" role="group" aria-label={label}>{children}</div>;
}
export function Badge({ children, tone = 'default', icon, title }: { children: React.ReactNode; tone?: 'default' | 'accent' | 'danger' | 'ok' | 'muted'; icon?: IconName; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}
export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';
}
export function Avatar({ name, color, size = 'md', ring = false }: { name: string; color: string; size?: 'sm' | 'md' | 'lg'; ring?: boolean }) {
  return <span className={`avatar avatar-${size}${ring ? ' avatar-ring' : ''}`} style={{ '--user': color } as React.CSSProperties} title={name}>{initials(name)}</span>;
}
export function AvatarStack({ people, max = 3 }: { people: { id: string; name: string; color: string }[]; max?: number }) {
  if (!people.length) return null;
  return <span className="avatar-stack" title={people.map(p => p.name).join(', ')}>
    {people.slice(0, max).map(p => <Avatar key={p.id} name={p.name} color={p.color} size="sm" />)}
    {people.length > max && <span className="avatar avatar-sm avatar-more">+{people.length - max}</span>}
  </span>;
}
export function Panel({ title, icon, actions, children, className, tone }: { title?: React.ReactNode; icon?: IconName; actions?: React.ReactNode; children: React.ReactNode; className?: string; tone?: 'accent' | 'danger' }) {
  return <section className={`panel${tone ? ` panel-${tone}` : ''}${className ? ` ${className}` : ''}`}>
    {(title || actions) && <header className="panel-head">{title && <h2>{icon && <Icon name={icon} />}{title}</h2>}{actions && <div className="panel-actions">{actions}</div>}</header>}
    <div className="panel-body">{children}</div>
  </section>;
}
export function Field({ label, hint, children, error, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; error?: string; className?: string }) {
  return <label className={`field${error ? ' field-error' : ''}${className ? ` ${className}` : ''}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}{error && <span className="field-hint field-hint-error">{error}</span>}</label>;
}
export function Empty({ icon, title, children, actions }: { icon: IconName; title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="empty"><Icon name={icon} size={36} /><h3>{title}</h3>{children && <p>{children}</p>}{actions && <div className="empty-actions">{actions}</div>}</div>;
}
export function Alert({ tone = 'danger', children, onDismiss, icon }: { tone?: 'danger' | 'info' | 'accent'; children: React.ReactNode; onDismiss?: () => void; icon?: IconName }) {
  return <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><Icon name={icon ?? (tone === 'danger' ? 'warning' : 'info')} /><div className="alert-body">{children}</div>{onDismiss && <IconButton icon="close" label="Dismiss" onClick={onDismiss} />}</div>;
}
export function Eyebrow({ children, icon }: { children: React.ReactNode; icon?: IconName }) {
  return <div className="eyebrow">{icon && <Icon name={icon} size={12} />}{children}</div>;
}
export function Code({ children, big = false }: { children: React.ReactNode; big?: boolean }) {
  return <code className={`id-code${big ? ' id-code-big' : ''}`}>{children}</code>;
}
