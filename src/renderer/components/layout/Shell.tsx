import React from 'react';
import { Icon, type IconName } from '../ui/Icon.js';
export function Brand({ mode }: { mode: string }) {
  return <div className="brand"><span className="brand-mark">H</span><span className="brand-name"><strong>HLR</strong><small>{mode}</small></span></div>;
}
export function StatusBar({ items }: { items: { icon: IconName; text: React.ReactNode; tone?: 'accent' | 'danger' | 'ok' }[] }) {
  return <footer className="statusbar">{items.map((item, i) => <span key={i} className={item.tone ? `status-${item.tone}` : undefined}><Icon name={item.icon} size={12} />{item.text}</span>)}<span className="status-version">HLR Writing Tool · 0.6.0</span></footer>;
}
