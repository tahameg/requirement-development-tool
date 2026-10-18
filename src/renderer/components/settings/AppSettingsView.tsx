import React, { useState } from 'react';
import type { AppSettings } from '../../../shared/appSettings.js';
import { Button, Eyebrow, Field } from '../ui/primitives.js';
import { Icon } from '../ui/Icon.js';
const themes: { value: AppSettings['general']['theme']; label: string }[] = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'high-contrast', label: 'High contrast' }];
export function AppSettingsView({ settings, path, busy, onSave, onCancel }: { settings: AppSettings; path: string; busy: boolean; onSave: (general: AppSettings['general']) => void; onCancel: () => void }) {
  const [general, setGeneral] = useState(settings.general);
  return <section className="form-page"><Eyebrow icon="settings">Preferences</Eyebrow><h1>Application settings</h1><p>Saved on this computer and shared by all your projects.</p>
    <form className="panel form-panel" onSubmit={e => { e.preventDefault(); onSave(general); }}>
      <div className="field"><span className="field-label">Appearance</span><div className="theme-picker" role="radiogroup" aria-label="Appearance">
        {themes.map(t => <button type="button" role="radio" key={t.value} aria-checked={general.theme === t.value} className={`theme-swatch swatch-${t.value}${general.theme === t.value ? ' on' : ''}`} onClick={() => setGeneral({ ...general, theme: t.value })}><span className="swatch" /><strong>{t.label}</strong></button>)}
      </div></div>
      <Field label="Autosave interval (seconds)" hint="0 turns autosave off for local projects. Team rooms always save continuously."><input type="number" min={0} max={86400} value={general.auto_save_interval_sec} onChange={e => setGeneral({ ...general, auto_save_interval_sec: Number(e.target.value) })} /></Field>
      <div className="filepath"><Icon name="settings" size={14} />{path}</div>
      <div className="form-actions"><Button onClick={onCancel}>Cancel</Button><Button type="submit" tone="primary" icon="save" disabled={busy}>Save preferences</Button></div>
    </form></section>;
}
