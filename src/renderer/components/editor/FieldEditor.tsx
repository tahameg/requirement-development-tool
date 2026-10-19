import React, { useState } from 'react';
import type { Column } from '../../../shared/types/config.js';
import type { Item } from '../../../shared/types/workspace.js';
import type { ReferenceTarget } from '../../../shared/references.js';
export function FieldEditor({ column, value, onChange, targets, autoFocus }: { column: Column; value: Item['values'][string] | undefined; onChange: (value: Item['values'][string]) => void; targets: ReferenceTarget[]; autoFocus?: boolean }) {
  const [query, setQuery] = useState('');
  if (column.type === 'reference') {
    const options = targets.filter(target => (!column.referenceTypes || column.referenceTypes.includes(target.objectType)) && `${target.id} ${target.label}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100);
    const selected = targets.find(target => target.id === value);
    return <div className="reference-picker"><input aria-label={`Find ${column.name}`} placeholder="Find ID or name…" value={query} onChange={e => setQuery(e.target.value)} autoFocus={autoFocus} /><select aria-label={column.name} value={String(value ?? '')} onChange={e => onChange(e.target.value)}><option value="">Choose a reference…</option>{selected && !options.some(option => option.id === selected.id) && <option value={selected.id}>{selected.id} — {selected.label}</option>}{options.map(target => <option key={target.id} value={target.id}>{target.id} — {target.label}</option>)}</select></div>;
  }
  if (column.type === 'boolean') return <div className="segmented" role="radiogroup" aria-label={column.name}>
    {([[true, 'Yes'], [false, 'No'], [null, '—']] as const).map(([option, label]) => <button key={label} type="button" role="radio" aria-checked={(value ?? null) === option} className={(value ?? null) === option ? 'on' : ''} onClick={() => onChange(option)}>{label}</button>)}
  </div>;
  if (column.type === 'enum') return <select aria-label={column.name} value={String(value ?? '')} autoFocus={autoFocus} onChange={e => onChange(e.target.value === '' ? null : e.target.value)}><option value="">Select…</option>{(column.options ?? []).map(option => <option key={option}>{option}</option>)}</select>;
  if (['text', 'markdown'].includes(column.type)) return <textarea aria-label={column.name} rows={3} value={String(value ?? '')} autoFocus={autoFocus} onChange={e => onChange(e.target.value)} />;
  return <input aria-label={column.name} type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'} step={column.type === 'number' ? 'any' : undefined} value={String(value ?? '')} autoFocus={autoFocus} onChange={e => onChange(column.type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value)} />;
}
/** Read-only rendering of a stored value, shared by the offline grid and the room table. */
export function displayValue(column: Column, value: Item['values'][string] | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
