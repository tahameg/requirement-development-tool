import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FunctionGroup, Item, Workspace } from '../../../shared/types/workspace.js';
import type { ObjectType } from '../../../shared/types/config.js';
import type { FunctionEdit, ExportRequest } from '../../../shared/authoring.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
import { referenceTargets } from '../../../shared/references.js';
import { FieldEditor } from './FieldEditor.js';
export type DraftListener = (dirty: boolean, save: (() => Promise<void>) | null) => void;
interface Props {
  workspace: Workspace; fn: FunctionGroup; objectType: ObjectType; busy: boolean; preview: string; autosave: number;
  onSave: (command: FunctionEdit) => Promise<void>; onDraft: DraftListener; onSelect: (selection: HierarchySelection, itemId?: string) => void;
  onExport: (request: ExportRequest) => void; focusedItem?: string | null;
}
export function FunctionEditor({ workspace, fn, objectType, busy, preview, autosave, onSave, onDraft, onSelect, onExport, focusedItem }: Props) {
  const [description, setDescription] = useState(fn.description);
  const [showPreview, setShowPreview] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(true);
  const [row, setRow] = useState<{ id: string | null; values: Item['values'] } | null>(null);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const enabled = workspace.config.objectTypes[objectType].enabled;
  const columns = workspace.config.objectTypes[objectType].columns;
  const targets = useMemo(() => referenceTargets(workspace), [workspace]);
  const dirty = description !== fn.description || !!row;
  const save = useCallback(async () => {
    if (saving.current || busy) return;
    saving.current = true; setError('');
    try {
      await onSave({ objectType, functionId: fn.functionId, description, changes: row ? [row.id ? { action: 'edit', id: row.id, values: row.values } : { action: 'add', values: row.values }] : [] });
      setRow(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save'); }
    finally { saving.current = false; }
  }, [busy, description, fn.functionId, objectType, onSave, row]);
  useEffect(() => { onDraft(dirty, dirty ? save : null); }, [dirty, onDraft, save]);
  useEffect(() => () => onDraft(false, null), [onDraft]);
  useEffect(() => {
    if (!dirty || !autosave || busy) return;
    const timer = setTimeout(() => void save(), autosave * 1000);
    return () => clearTimeout(timer);
  }, [autosave, busy, dirty, save]);
  useEffect(() => { if (remove) dialog.current?.showModal(); }, [remove]);
  useEffect(() => {
    const index = fn.items.findIndex(item => item.id === focusedItem);
    if (index >= 0 && viewport.current) { viewport.current.scrollTop = index * 64; setScrollTop(index * 64); }
  }, [focusedItem, fn.functionId]);
  const rows = row?.id === null ? [...fn.items, { id: '__new__', seq: 0, created_at: '', values: row.values }] : fn.items;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / 64) - 3, Math.max(0, rows.length - 1)));
  const end = Math.min(rows.length, start + 18);
  function add() {
    if (dirty) { setError('Save or cancel your current edits before adding another item.'); return; }
    setRow({ id: null, values: Object.fromEntries(columns.filter(c => c.default !== undefined).map(c => [c.id, c.default!])) });
    setError('');
    requestAnimationFrame(() => { if (viewport.current) { viewport.current.scrollTop = rows.length * 64; setScrollTop(rows.length * 64); } });
  }
  async function deleteRow() {
    if (!remove) return;
    try { await onSave({ objectType, functionId: fn.functionId, changes: [{ action: 'delete', id: remove }] }); setRemove(null); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to delete'); setRemove(null); }
  }
  return <>
    <section className="scope-card"><div className="section-heading"><button className="text-button" aria-expanded={scopeOpen} onClick={() => setScopeOpen(!scopeOpen)}>Scope {scopeOpen ? '⌄' : '›'}</button><div className="heading-actions"><span className="prefix-badge">Prefix: {fn.prefix}</span><button onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Edit description' : 'Preview Markdown'}</button></div></div>
      {scopeOpen && (showPreview ? <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ children }) => <span className="markdown-link">{children}</span> }}>{description || '*No description yet.*'}</Markdown></div> : <textarea className="scope-input" aria-label="Function description" disabled={!enabled || busy} placeholder="Describe scope, inputs, outputs and rationale. Markdown is supported." rows={4} value={description} onChange={e => setDescription(e.target.value)} />)}
      <div className="id-preview"><span>Next item ID</span><code>{preview}</code></div>
    </section>
    <section className="workspace-card editor-card"><div className="section-heading"><h2>{objectLabels[objectType]} <span className="count">{fn.items.length}</span></h2><div className="heading-actions"><button disabled={busy || dirty} onClick={() => onExport({ format: 'csv', objectType, functionId: fn.functionId })}>Export CSV</button><button disabled={busy || dirty} onClick={() => onExport({ format: 'markdown', objectType, functionId: fn.functionId })}>Export Markdown</button>{enabled && <button className="primary" disabled={busy || !!row} onClick={add}>{objectType === 'REQUIREMENT' ? 'Add requirement' : 'Add item'}</button>}</div></div>
      {error && <p role="alert" className="error">{error}</p>}
      {dirty && <div className="draft-toolbar"><span>Unsaved edits{row?.id === null ? ' · New item ID is assigned when saved' : ''}</span><button disabled={busy} onClick={() => { setDescription(fn.description); setRow(null); setError(''); }}>Cancel edits</button><button className="primary" disabled={busy} onClick={() => void save()}>Save changes</button></div>}
      <div className="virtual-table read-only-table" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}><table aria-label={`${objectLabels[objectType]} items`} aria-rowcount={rows.length + 1}><thead><tr><th>ID</th>{columns.map(c => <th key={c.id}>{c.name}{c.required ? ' *' : ''}</th>)}<th>Actions</th></tr></thead><tbody>
        {start > 0 && <tr aria-hidden="true" className="spacer-row"><td colSpan={columns.length + 2} style={{ height: start * 64 }} /></tr>}
        {rows.slice(start, end).map((item, offset) => {
          const active = row && (row.id === item.id || row.id === null && item.id === '__new__');
          return <tr key={item.id} aria-rowindex={start + offset + 2} className={`${active ? 'editing-row' : ''} ${focusedItem === item.id ? 'target-row' : ''}`}><td><code>{item.id === '__new__' ? preview : item.id}</code>{item.id === '__new__' && <small>Pending</small>}</td>{columns.map(column => {
            const value = active ? row.values[column.id] : item.values[column.id];
            const target = column.type === 'reference' ? targets.find(t => t.id === value) : undefined;
            return <td key={column.id}>{active ? <FieldEditor column={column} value={value} targets={targets} onChange={value => setRow({ ...row, values: { ...row.values, [column.id]: value } })} /> : <div className="cell-content"><button className="cell-edit" aria-label={`Edit ${column.name} for ${item.id}`} disabled={busy || !enabled || !!row} onClick={() => setRow({ id: item.id, values: { ...item.values } })} title={String(value ?? '')}>{String(value ?? '') || '—'}</button>{target && <button className="reference-open" aria-label={`Open reference ${target.id}`} onClick={() => onSelect({ objectType: target.objectType, kind: 'function', id: target.functionId }, target.id)}>↗</button>}</div>}</td>;
          })}<td>{enabled && item.id !== '__new__' && <button className="danger-text" disabled={busy || dirty} aria-label={`Delete ${item.id}`} onClick={() => setRemove(item.id)}>Delete</button>}</td></tr>;
        })}
        {end < rows.length && <tr aria-hidden="true" className="spacer-row"><td colSpan={columns.length + 2} style={{ height: (rows.length - end) * 64 }} /></tr>}
      </tbody></table></div>{!rows.length && <p className="hint">Add the first item to begin writing.</p>}
    </section>
    {remove && <dialog ref={dialog} className="hierarchy-dialog" onCancel={() => setRemove(null)} aria-labelledby="delete-item-title"><h2 id="delete-item-title">Delete this item?</h2><p><code>{remove}</code></p><p>Its ID will be permanently retired. Remaining items keep their IDs.</p><div className="actions"><button autoFocus disabled={busy} onClick={() => setRemove(null)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void deleteRow()}>Delete permanently</button></div></dialog>}
  </>;
}
