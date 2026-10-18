import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { DraftListener } from '../editor/RequirementSetEditor.js';
import type { ProjectConfig, ObjectType, Column } from '../../../shared/types/config.js';
import type { Workspace } from '../../../shared/types/workspace.js';
import { objectLabels } from '../../../shared/hierarchy.js';
import { objectTypes } from '../../../shared/types/schema.js';
import { plural } from '../../../shared/terminology.js';
import { Icon, columnIcons, objectIcons } from '../ui/Icon.js';
import { Alert, AvatarStack, Badge, Button, ButtonGroup, Field, IconButton } from '../ui/primitives.js';
import { useConfirm } from '../ui/Modal.js';
import type { Person } from '../tree/WorkspaceTree.js';

const columnTypes: { type: Column['type']; label: string; hint: string }[] = [
  { type: 'string', label: 'Short text', hint: 'One line: names, codes' },
  { type: 'text', label: 'Long text', hint: 'Plain multi-line text' },
  { type: 'markdown', label: 'Markdown', hint: 'Formatted statements' },
  { type: 'enum', label: 'Dropdown', hint: 'Pick one of fixed options' },
  { type: 'number', label: 'Number', hint: 'Integers or decimals' },
  { type: 'boolean', label: 'Yes / No', hint: 'A single switch' },
  { type: 'date', label: 'Date', hint: 'YYYY-MM-DD' },
  { type: 'reference', label: 'Reference', hint: 'Link to another item' },
];
const typeLabel = (type: Column['type']) => columnTypes.find(t => t.type === type)!.label;
const referenceable = ['DATA_DICTIONARY', 'ENTITY', 'ACTION'] as const;
function cased(config: ProjectConfig, token: string) { return config.idCasing === 'UPPER' ? token.toUpperCase() : config.idCasing === 'LOWER' ? token.toLowerCase() : token; }
function sampleValue(column: Column): string {
  if (column.default !== undefined && column.default !== null && column.default !== '') return column.type === 'boolean' ? (column.default ? 'Yes' : 'No') : String(column.default);
  return { string: 'Short text', text: 'Longer explanation…', markdown: 'The system **shall**…', enum: column.options?.[0] ?? 'Option', number: '42', boolean: 'Yes', date: '2026-10-18', reference: 'DI-GS-…-001' }[column.type];
}
interface Change { tone: 'add' | 'remove' | 'change'; text: string }
function describeChanges(before: ProjectConfig, after: ProjectConfig, stored: (type: ObjectType, column: string) => number): Change[] {
  const changes: Change[] = [];
  if (before.projectName !== after.projectName) changes.push({ tone: 'change', text: `Project renamed to “${after.projectName}”` });
  if (before.projectPrefix !== after.projectPrefix || before.idCasing !== after.idCasing) changes.push({ tone: 'change', text: 'Naming rules changed: new items get the new ID format, existing IDs stay' });
  for (const type of objectTypes) {
    const a = before.objectTypes[type], b = after.objectTypes[type], label = objectLabels[type];
    if (a.enabled !== b.enabled) changes.push({ tone: b.enabled ? 'add' : 'remove', text: `${label} ${b.enabled ? 'enabled' : 'disabled'}` });
    if (a.prefix !== b.prefix || a.usePrefix !== b.usePrefix) changes.push({ tone: 'change', text: `${label} prefix → ${b.usePrefix ? b.prefix || '(empty)' : 'not used'}` });
    for (const column of b.columns) {
      const old = a.columns.find(c => c.id === column.id);
      if (!old) changes.push({ tone: 'add', text: `${label}: new column “${column.name}” (${typeLabel(column.type)})` });
      else {
        if (old.name !== column.name) changes.push({ tone: 'change', text: `${label}: “${old.name}” renamed to “${column.name}”` });
        if (old.type !== column.type) changes.push({ tone: 'remove', text: `${label}: “${column.name}” type ${typeLabel(old.type)} → ${typeLabel(column.type)}. Incompatible stored values are rejected.` });
        if (!old.required && column.required) changes.push({ tone: 'change', text: `${label}: “${column.name}” is now required` });
      }
    }
    for (const column of a.columns) if (!b.columns.some(c => c.id === column.id)) {
      const count = stored(type, column.id);
      changes.push({ tone: 'remove', text: `${label}: column “${column.name}” removed${count ? `. ${plural(count, 'stored value')} will be deleted` : ''}` });
    }
    const kept = b.columns.map(c => c.id).filter(id => a.columns.some(c => c.id === id));
    if (kept.join() !== a.columns.map(c => c.id).filter(id => kept.includes(id)).join()) changes.push({ tone: 'change', text: `${label}: column order changed` });
  }
  return changes;
}
export function ProjectSettings({ current, workspace, busy, onSave, onCancel, onDraft, waiting = [] }: {
  current: ProjectConfig; workspace?: Workspace; busy: boolean; onSave: (config: ProjectConfig) => Promise<void>; onCancel: () => void; onDraft: DraftListener;
  /** Collaborators paused while this settings session is open. */
  waiting?: Person[];
}) {
  const [config, setConfig] = useState(() => structuredClone(current));
  const [error, setError] = useState('');
  const [type, setType] = useState<ObjectType>('REQUIREMENT');
  const [open, setOpen] = useState<string | null>(null);
  const confirm = useConfirm();
  const stored = useCallback((t: ObjectType, column: string) => workspace?.domains[t].requirementSets.reduce((n, s) => n + s.items.filter(i => i.values[column] !== undefined && i.values[column] !== null && i.values[column] !== '').length, 0) ?? 0, [workspace]);
  const itemsOf = (t: ObjectType) => workspace?.domains[t].requirementSets.reduce((n, s) => n + s.items.length, 0) ?? 0;
  const changes = useMemo(() => describeChanges(current, config, stored), [current, config, stored]);
  const dirty = changes.length > 0 || JSON.stringify(config) !== JSON.stringify(current);
  const save = useCallback(async () => {
    setError('');
    const destructive = changes.filter(c => c.tone === 'remove');
    if (destructive.length && !await confirm({ title: 'Apply destructive changes?', tone: 'danger', icon: 'warning', confirmLabel: 'Apply changes', body: <ul className="change-list">{destructive.map((c, i) => <li key={i} className="change-remove">{c.text}</li>)}</ul> })) return;
    try { await onSave(config); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save settings'); }
  }, [changes, config, confirm, onSave]);
  useEffect(() => { onDraft(dirty, dirty ? save : null); }, [dirty, onDraft, save]);
  useEffect(() => () => onDraft(false, null), [onDraft]);
  const object = config.objectTypes[type];
  function updateObject(update: Partial<typeof object>) { setConfig(c => ({ ...c, objectTypes: { ...c.objectTypes, [type]: { ...c.objectTypes[type], ...update } } })); }
  function editColumn(id: string, update: Partial<Column>) { updateObject({ columns: object.columns.map(column => column.id === id ? { ...column, ...update } : column) }); }
  function move(index: number, direction: number) { const columns = [...object.columns]; [columns[index], columns[index + direction]] = [columns[index + direction]!, columns[index]!]; updateObject({ columns }); }
  async function remove(column: Column) {
    const count = stored(type, column.id);
    if (!count || await confirm({ title: `Remove “${column.name}”?`, tone: 'danger', icon: 'trash', confirmLabel: 'Remove column', body: <p>{plural(count, 'item')} hold a value in this column. The values are deleted when you save the settings.</p> }))
      updateObject({ columns: object.columns.filter(c => c.id !== column.id) });
  }
  function addColumn(kind: Column['type']) {
    const id = `col_${crypto.randomUUID()}`;
    const name = `New ${typeLabel(kind).toLowerCase()}`;
    updateObject({ columns: [...object.columns, { id, name, type: kind, ...kind === 'enum' ? { options: ['Option 1'] } : {}, ...kind === 'reference' ? { referenceTypes: [...referenceable] } : {} }] });
    setOpen(id);
  }
  function retype(column: Column, kind: Column['type']) {
    editColumn(column.id, { type: kind, default: undefined, options: kind === 'enum' ? column.options ?? ['Option 1'] : undefined, referenceTypes: kind === 'reference' ? [...referenceable] : undefined });
  }
  const anatomy = [
    ...object.usePrefix && object.prefix ? [{ part: 'Type', token: object.prefix }] : [],
    ...config.projectPrefix ? [{ part: 'Project', token: config.projectPrefix }] : [],
    { part: 'Components', token: 'COMPL' }, { part: 'Set', token: 'PRS' },
  ];
  return <section className="data-definition">
    <header className="dd-head">
      <div><div className="eyebrow"><Icon name="database" size={12} />Data definition</div><h1>Project settings</h1><p>Shape what every item in this project holds. Existing IDs never change.</p></div>
      {waiting.length > 0 && <div className="dd-session"><Icon name="pause" /><div><strong>Room paused</strong><span>{plural(waiting.length, 'collaborator')} waiting for you to finish</span></div><AvatarStack people={waiting} max={5} /></div>}
    </header>
    {error && <Alert onDismiss={() => setError('')}>{error}</Alert>}
    <form id="project-settings" onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="dd-identity">
        <Field label="Project name"><input required value={config.projectName} onChange={e => setConfig({ ...config, projectName: e.target.value })} /></Field>
        <Field label="Project prefix"><input className="mono" value={config.projectPrefix} onChange={e => setConfig({ ...config, projectPrefix: e.target.value })} placeholder="GS" /></Field>
        <div className="field"><span className="field-label">ID casing</span><div className="segmented literal" role="radiogroup" aria-label="ID casing">
          {([['UPPER', 'ABC'], ['LOWER', 'abc'], ['AS_IS', 'As typed']] as const).map(([value, label]) => <button type="button" key={value} role="radio" aria-checked={config.idCasing === value} className={config.idCasing === value ? 'on' : ''} onClick={() => setConfig({ ...config, idCasing: value })}>{label}</button>)}
        </div></div>
        <div className="id-anatomy" aria-label="ID anatomy">{anatomy.map((a, i) => <React.Fragment key={a.part}><span className={`token token-${i}`}><b>{cased(config, a.token)}</b><small>{a.part}</small></span><span className="dash">-</span></React.Fragment>)}<span className="token token-seq"><b>001</b><small>Sequence</small></span></div>
      </fieldset>
      <div className="dd-body">
        <nav className="dd-types" role="tablist" aria-label="Object types">
          {objectTypes.map(t => { const o = config.objectTypes[t]; return <button type="button" role="tab" key={t} aria-selected={t === type} className={`dd-type type-${t}${t === type ? ' on' : ''}${o.enabled ? '' : ' disabled'}`} onClick={() => { setType(t); setOpen(null); }}>
            <Icon name={objectIcons[t]} size={20} /><span><strong>{objectLabels[t]}</strong><small>{plural(o.columns.length, 'column')} · {plural(itemsOf(t), 'item')}</small></span>{!o.enabled && <Badge tone="muted">Off</Badge>}
          </button>; })}
        </nav>
        <div className={`dd-editor type-${type}`}>
          <fieldset disabled={busy} className="dd-type-card">
            <div className="dd-type-title"><Icon name={objectIcons[type]} size={26} /><h2>{objectLabels[type]}</h2></div>
            <label className="switch"><input type="checkbox" checked={object.enabled} onChange={e => updateObject({ enabled: e.target.checked })} /><span className="switch-track" /><span>Enabled</span></label>
            <label className="switch"><input type="checkbox" checked={object.usePrefix} onChange={e => updateObject({ usePrefix: e.target.checked })} /><span className="switch-track" /><span>Prefix IDs</span></label>
            <Field label="Type prefix" className="prefix-field"><input aria-label="Object prefix" className="mono" disabled={!object.usePrefix} value={object.prefix} onChange={e => updateObject({ prefix: e.target.value })} /></Field>
          </fieldset>
          <div className="dd-columns-head"><h3><Icon name="list" />Columns</h3><span className="hint">Order here is the order in the table.</span></div>
          <ol className="dd-columns">
            {object.columns.map((column, index) => { const expanded = open === column.id; const values = stored(type, column.id); return <li key={column.id} className={`dd-column${expanded ? ' open' : ''}`}>
              <fieldset disabled={busy}>
                <div className="dd-column-row">
                  <span className="dd-order"><IconButton icon="arrowUp" label={`Move ${column.name} up`} disabled={index === 0} onClick={() => move(index, -1)} /><IconButton icon="arrowDown" label={`Move ${column.name} down`} disabled={index === object.columns.length - 1} onClick={() => move(index, 1)} /></span>
                  <span className={`type-tile tile-${column.type}`} title={typeLabel(column.type)}><Icon name={columnIcons[column.type]} size={18} /></span>
                  <input className="dd-column-name" aria-label={`Column ${index + 1} name`} required value={column.name} onChange={e => editColumn(column.id, { name: e.target.value })} />
                  <span className="dd-column-tags"><Badge>{typeLabel(column.type)}</Badge>{column.required && <Badge tone="accent">Required</Badge>}{column.system && <Badge tone="muted" icon="lock">System</Badge>}{values > 0 && <Badge tone="muted">{plural(values, 'value')}</Badge>}</span>
                  <IconButton icon={expanded ? 'chevronDown' : 'sliders'} label={`${expanded ? 'Collapse' : 'Configure'} ${column.name}`} onClick={() => setOpen(expanded ? null : column.id)} />
                  <IconButton icon="trash" tone="danger" label={`Remove ${column.name}`} disabled={column.system} onClick={() => void remove(column)} />
                </div>
                {expanded && <div className="dd-column-detail">
                  <div className="type-picker" role="radiogroup" aria-label={`Column ${index + 1} type`}>{columnTypes.map(t => <button type="button" key={t.type} role="radio" aria-checked={column.type === t.type} disabled={column.system} className={`type-option tile-${t.type}${column.type === t.type ? ' on' : ''}`} onClick={() => retype(column, t.type)}><Icon name={columnIcons[t.type]} size={20} /><strong>{t.label}</strong><small>{t.hint}</small></button>)}</div>
                  <div className="dd-detail-grid">
                    <label className="switch"><input type="checkbox" disabled={column.system} checked={!!column.required} onChange={e => editColumn(column.id, { required: e.target.checked })} /><span className="switch-track" /><span>Required</span></label>
                    {column.type === 'enum' && <OptionsEditor options={column.options ?? []} onChange={options => editColumn(column.id, { options, default: options.includes(String(column.default)) ? column.default : undefined })} label={`Column ${index + 1} options`} />}
                    {column.type === 'reference' ? <div className="field"><span className="field-label">Can point to</span><div className="chip-toggles">{referenceable.map(target => { const on = column.referenceTypes?.includes(target) ?? true; return <button type="button" key={target} className={`chip type-${target}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => { const next = on ? (column.referenceTypes ?? [...referenceable]).filter(t => t !== target) : [...column.referenceTypes ?? [], target]; if (next.length) editColumn(column.id, { referenceTypes: next }); }}><Icon name={objectIcons[target]} size={12} />{objectLabels[target]}</button>; })}</div></div>
                      : <Field label="Default for new items" hint={column.required && !column.default && values === 0 && itemsOf(type) > 0 ? 'Existing items need a default before a required column can be added.' : undefined}>{column.type === 'boolean'
                        ? <select aria-label={`Column ${index + 1} default`} value={String(column.default ?? '')} onChange={e => editColumn(column.id, { default: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">No default</option><option value="true">Yes</option><option value="false">No</option></select>
                        : column.type === 'enum' ? <select aria-label={`Column ${index + 1} default`} value={String(column.default ?? '')} onChange={e => editColumn(column.id, { default: e.target.value || undefined })}><option value="">No default</option>{(column.options ?? []).filter(Boolean).map(o => <option key={o}>{o}</option>)}</select>
                        : <input aria-label={`Column ${index + 1} default`} type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'} value={String(column.default ?? '')} onChange={e => editColumn(column.id, { default: e.target.value === '' ? undefined : column.type === 'number' ? Number(e.target.value) : e.target.value })} />}</Field>}
                  </div>
                </div>}
              </fieldset>
            </li>; })}
          </ol>
          <div className="dd-add" aria-label="Add a column"><span className="eyebrow"><Icon name="plus" size={12} />Add column</span><div className="dd-add-tiles">{columnTypes.map(t => <button type="button" key={t.type} disabled={busy} className={`type-option tile-${t.type}`} onClick={() => addColumn(t.type)} title={t.hint}><Icon name={columnIcons[t.type]} size={18} /><strong>{t.label}</strong></button>)}</div></div>
          <div className="dd-preview"><span className="eyebrow"><Icon name="eye" size={12} />Preview of the {objectLabels[type]} table</span>
            <div className="table-scroll"><table className="grid"><thead><tr><th className="col-id"><Icon name="hash" size={12} />ID</th>{object.columns.map(c => <th key={c.id}><Icon name={columnIcons[c.type]} size={12} />{c.name || 'Untitled'}{c.required && <span className="req">*</span>}</th>)}</tr></thead>
              <tbody><tr><td className="col-id"><code className="id-code">{[...anatomy.map(a => cased(config, a.token)), '001'].join('-')}</code></td>{object.columns.map(c => <td key={c.id}><span className={c.default === undefined ? 'muted' : ''}>{sampleValue(c)}</span></td>)}</tr></tbody></table></div>
          </div>
        </div>
      </div>
    </form>
    <footer className={`dd-foot${dirty ? ' dirty' : ''}`}>
      <div className="dd-changes">{dirty ? <><strong><Icon name="edit" size={14} />{plural(changes.length || 1, 'unsaved change')}</strong><ul className="change-list">{changes.slice(0, 4).map((c, i) => <li key={i} className={`change-${c.tone}`}>{c.text}</li>)}{changes.length > 4 && <li>…and {changes.length - 4} more</li>}</ul></> : <span className="hint"><Icon name="check" size={14} />No changes</span>}</div>
      <ButtonGroup label="Settings"><Button onClick={onCancel} disabled={busy}>{dirty ? 'Discard' : 'Close'}</Button><Button type="submit" form="project-settings" tone="primary" icon="save" disabled={busy || !dirty}>Save project settings</Button></ButtonGroup>
    </footer>
  </section>;
}
function OptionsEditor({ options, onChange, label }: { options: string[]; onChange: (options: string[]) => void; label: string }) {
  const [draft, setDraft] = useState('');
  const add = () => { const value = draft.trim(); if (value && !options.includes(value)) onChange([...options, value]); setDraft(''); };
  return <div className="field options-editor"><span className="field-label">Options</span>
    <div className="chips" aria-label={label}>{options.map((option, i) => <span key={`${option}-${i}`} className="chip on">{option}<button type="button" aria-label={`Remove option ${option}`} disabled={options.length <= 1} onClick={() => onChange(options.filter((_, x) => x !== i))}><Icon name="close" size={10} /></button></span>)}
      <input aria-label={`${label} new`} placeholder="Add option, press Enter" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} /></div>
  </div>;
}
