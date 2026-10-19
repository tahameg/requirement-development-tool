import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequirementSet, Item, Workspace } from '../../../shared/types/workspace.js';
import type { ObjectType } from '../../../shared/types/config.js';
import type { RequirementSetEdit, ExportRequest } from '../../../shared/authoring.js';
import { objectLabels, type HierarchySelection } from '../../../shared/hierarchy.js';
import { referenceTargets } from '../../../shared/references.js';
import { FieldEditor, displayValue } from './FieldEditor.js';
import { ScopeMarkdown } from './Scope.js';
import { Icon, columnIcons } from '../ui/Icon.js';
import { Alert, Button, ButtonGroup, Code, IconButton, Panel } from '../ui/primitives.js';
import { useConfirm } from '../ui/Modal.js';
export type DraftListener = (dirty: boolean, save: (() => Promise<void>) | null) => void;
interface Props {
  workspace: Workspace; set: RequirementSet; objectType: ObjectType; busy: boolean; preview: string; autosave: number;
  onSave: (command: RequirementSetEdit) => Promise<void>; onDraft: DraftListener; onSelect: (selection: HierarchySelection, itemId?: string) => void;
  onExport: (request: ExportRequest) => void; focusedItem?: string | null;
}
const ROW = 64;
export function RequirementSetEditor({ workspace, set, objectType, busy, preview, autosave, onSave, onDraft, onSelect, onExport, focusedItem }: Props) {
  const [description, setDescription] = useState(set.description);
  const [showPreview, setShowPreview] = useState(false);
  const [row, setRow] = useState<{ id: string | null; values: Item['values']; column?: string } | null>(null);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const confirm = useConfirm();
  const enabled = workspace.config.objectTypes[objectType].enabled;
  const columns = workspace.config.objectTypes[objectType].columns;
  const targets = useMemo(() => referenceTargets(workspace), [workspace]);
  const dirty = description !== set.description || !!row;
  const save = useCallback(async () => {
    if (saving.current || busy) return;
    saving.current = true; setError('');
    try {
      await onSave({ objectType, requirementSetId: set.requirementSetId, description, changes: row ? [row.id ? { action: 'edit', id: row.id, values: row.values } : { action: 'add', values: row.values }] : [] });
      setRow(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save'); }
    finally { saving.current = false; }
  }, [busy, description, set.requirementSetId, objectType, onSave, row]);
  useEffect(() => { onDraft(dirty, dirty ? save : null); }, [dirty, onDraft, save]);
  useEffect(() => () => onDraft(false, null), [onDraft]);
  useEffect(() => {
    if (!dirty || !autosave || busy) return;
    const timer = setTimeout(() => void save(), autosave * 1000);
    return () => clearTimeout(timer);
  }, [autosave, busy, dirty, save]);
  useEffect(() => {
    const index = set.items.findIndex(item => item.id === focusedItem);
    if (index >= 0 && viewport.current) { viewport.current.scrollTop = index * ROW; setScrollTop(index * ROW); }
  }, [focusedItem, set.requirementSetId]);
  const rows = row?.id === null ? [...set.items, { id: '__new__', seq: 0, created_at: '', values: row.values }] : set.items;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / ROW) - 3, Math.max(0, rows.length - 1)));
  const end = Math.min(rows.length, start + 18);
  function add() {
    if (dirty) { setError('Save or cancel your current edits before adding another item.'); return; }
    setRow({ id: null, values: Object.fromEntries(columns.filter(c => c.default !== undefined).map(c => [c.id, c.default!])) });
    setError('');
    requestAnimationFrame(() => { if (viewport.current) { viewport.current.scrollTop = rows.length * ROW; setScrollTop(rows.length * ROW); } });
  }
  async function deleteRow(id: string) {
    if (!await confirm({ title: `Delete ${id}?`, tone: 'danger', icon: 'trash', confirmLabel: 'Delete permanently', body: <p>The ID is retired forever. Remaining items keep their IDs, so you get a gap, not a renumbering.</p> })) return;
    try { await onSave({ objectType, requirementSetId: set.requirementSetId, changes: [{ action: 'delete', id }] }); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to delete'); }
  }
  return <>
    <Panel title="Scope" icon="paragraph" className="scope-panel" actions={<div className="segmented" role="tablist" aria-label="Scope view">
      <button role="tab" aria-selected={!showPreview} className={!showPreview ? 'on' : ''} onClick={() => setShowPreview(false)}><Icon name="edit" size={12} />Write</button>
      <button role="tab" aria-selected={showPreview} className={showPreview ? 'on' : ''} onClick={() => setShowPreview(true)}><Icon name="eye" size={12} />Preview</button>
    </div>}>
      {showPreview ? <ScopeMarkdown text={description} /> : <textarea className="scope-input" aria-label="Requirement set description" disabled={!enabled || busy} placeholder="Describe scope, inputs, outputs and rationale. Markdown is supported." rows={5} value={description} onChange={e => setDescription(e.target.value)} />}
    </Panel>
    <Panel className="items-panel" title={<>{objectLabels[objectType]} <span className="count">{set.items.length}</span></>} icon="list" actions={<>
      <ButtonGroup label="Export">
        <Button icon="download" disabled={busy || dirty} onClick={() => onExport({ format: 'csv', objectType, requirementSetId: set.requirementSetId })}>CSV</Button>
        <Button icon="download" disabled={busy || dirty} onClick={() => onExport({ format: 'markdown', objectType, requirementSetId: set.requirementSetId })}>Markdown</Button>
      </ButtonGroup>
      {enabled && <ButtonGroup label="Author"><Button tone="primary" icon="plus" disabled={busy || !!row} onClick={add}>{objectType === 'REQUIREMENT' ? 'Add requirement' : 'Add item'}</Button></ButtonGroup>}
    </>}>
      {error && <Alert onDismiss={() => setError('')}>{error}</Alert>}
      {dirty && <div className="draft-bar"><Icon name="edit" /><span><strong>Unsaved edits</strong>{row?.id === null ? ' · The new ID is assigned when you save' : ''}</span>
        <ButtonGroup label="Draft"><Button icon="undo" disabled={busy} onClick={() => { setDescription(set.description); setRow(null); setError(''); }}>Discard</Button><Button tone="primary" icon="save" disabled={busy} kbd="Ctrl S" onClick={() => void save()}>Save</Button></ButtonGroup></div>}
      <div className="virtual-table" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <table className="grid" aria-label={`${objectLabels[objectType]} items`} aria-rowcount={rows.length + 1}>
          <thead><tr><th className="col-id"><Icon name="hash" size={12} />ID</th>{columns.map(c => <th key={c.id}><Icon name={columnIcons[c.type]} size={12} />{c.name}{c.required && <span className="req">*</span>}</th>)}<th className="col-actions"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {start > 0 && <tr aria-hidden="true" className="spacer-row"><td colSpan={columns.length + 2} style={{ height: start * ROW }} /></tr>}
            {rows.slice(start, end).map((item, offset) => {
              const active = row && (row.id === item.id || row.id === null && item.id === '__new__');
              return <tr key={item.id} aria-rowindex={start + offset + 2} className={`${active ? 'editing-row' : ''}${focusedItem === item.id ? ' target-row' : ''}`}>
                <td className="col-id"><Code>{item.id === '__new__' ? preview : item.id}</Code>{item.id === '__new__' && <span className="badge badge-accent">New</span>}</td>
                {columns.map(column => {
                  const value = active ? row.values[column.id] : item.values[column.id];
                  const target = column.type === 'reference' ? targets.find(t => t.id === value) : undefined;
                  return <td key={column.id}>{active ? <FieldEditor column={column} value={value} targets={targets} autoFocus={row.column === column.id} onChange={value => setRow({ ...row, values: { ...row.values, [column.id]: value } })} />
                    : <div className="cell-content"><button className="cell-edit" aria-label={`Edit ${column.name} for ${item.id}`} disabled={busy || !enabled || !!row} onClick={() => setRow({ id: item.id, values: { ...item.values }, column: column.id })} title={String(value ?? '')}>{displayValue(column, value) || <span className="muted">—</span>}</button>
                      {target && <IconButton icon="link" label={`Open reference ${target.id}`} onClick={() => onSelect({ objectType: target.objectType, kind: 'requirementSet', id: target.requirementSetId }, target.id)} />}</div>}</td>;
                })}
                <td className="col-actions">{enabled && item.id !== '__new__' && <IconButton icon="trash" tone="danger" disabled={busy || dirty} label={`Delete ${item.id}`} onClick={() => void deleteRow(item.id)} />}</td>
              </tr>;
            })}
            {end < rows.length && <tr aria-hidden="true" className="spacer-row"><td colSpan={columns.length + 2} style={{ height: (rows.length - end) * ROW }} /></tr>}
          </tbody>
        </table>
      </div>
      {!rows.length && <div className="table-empty"><Icon name="requirement" size={28} /><span>No items yet. Click <strong>{objectType === 'REQUIREMENT' ? 'Add requirement' : 'Add item'}</strong> to write the first one. It gets <Code>{preview}</Code>.</span></div>}
    </Panel>
  </>;
}
