import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CollabState, RoomDraft } from '../../../shared/collab/client.js';
import type { PresenceState } from '../../../shared/collab/types.js';
import type { ObjectType } from '../../../shared/types/config.js';
import { objectLabels } from '../../../shared/hierarchy.js';
import { capabilities, changedValues, lockStatus } from '../../../shared/collab/ui.js';
import { referenceTargets } from '../../../shared/references.js';
import { FieldEditor, displayValue } from '../editor/FieldEditor.js';
import { ScopeMarkdown } from '../editor/Scope.js';
import { Icon, columnIcons } from '../ui/Icon.js';
import { Alert, Avatar, Badge, Button, ButtonGroup, Code, IconButton, Panel } from '../ui/primitives.js';
import { useConfirm } from '../ui/Modal.js';
import { holderName, peers } from './presence.js';
import { collab } from './api.js';
export type PresenceUpdate = (patch: Partial<PresenceState>) => void;
const PAGE = 100;
export function RoomEditor({ state, objectType, requirementSetId, nextId, run, setPresence, paused }: {
  state: CollabState; objectType: ObjectType; requirementSetId: string; nextId: string; run: (fn: () => Promise<unknown>) => void;
  setPresence: PresenceUpdate; paused: boolean;
}) {
  const set = state.workspace!.domains[objectType].requirementSets.find(s => s.requirementSetId === requirementSetId);
  const columns = state.workspace!.config.objectTypes[objectType].columns;
  const cap = capabilities(state.role, state.connection === 'connected');
  const canEdit = cap.edit && !paused;
  const confirm = useConfirm();
  const initial = state.draft?.requirementSetId === requirementSetId && state.draft.kind !== 'description' ? state.draft : null;
  const [draft, setDraftState] = useState<RoomDraft | null>(initial); const draftRef = useRef(draft); const saving = useRef(false); const releaseRequested = useRef(false);
  const [scope, setScope] = useState<string | null>(state.draft?.kind === 'description' && state.draft.requirementSetId === requirementSetId ? String(state.draft.values.description) : null); const scopeRef = useRef<string | null>(scope);
  const [error, setError] = useState(''); const [offset, setOffset] = useState(0); const [filter, setFilter] = useState('');
  const [scopePreview, setScopePreview] = useState(false);
  const [focusColumn, setFocusColumn] = useState<string | null>(null);
  const draftFields = useRef<HTMLFieldSetElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(state); latest.current = state;
  const targets = useMemo(() => referenceTargets(state.workspace!), [state.workspace]);
  function updateDraft(next: RoomDraft | null) { draftRef.current = next; setDraftState(next); void collab(next ? { action: 'draft', draft: next } : { action: 'clear-draft' }).catch(e => setError(String(e))); }
  useEffect(() => { if (state.draft?.conflict && draftRef.current) { draftRef.current = { ...draftRef.current, conflict: state.draft.conflict }; setDraftState(draftRef.current); } }, [state.draft?.conflict]);
  // Project settings may drop columns; the client prunes the stored draft, so follow it.
  useEffect(() => { const stored = state.draft; if (stored && draftRef.current && stored.kind !== 'description' && Object.keys(stored.values).length < Object.keys(draftRef.current.values).length) { draftRef.current = { ...draftRef.current, values: stored.values, baseValues: stored.baseValues }; setDraftState(draftRef.current); } }, [state.draft?.values]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (draftRef.current || scopeRef.current !== null) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); if (timer.current) clearTimeout(timer.current); const id = draftRef.current?.itemId; if (id) void collab({ action: 'lock', kind: 'release', key: `item:${id}` }).catch(() => {}); if (scopeRef.current !== null) void collab({ action: 'lock', kind: 'release', key: `rs-desc:${requirementSetId}` }).catch(() => {}); };
  }, [requirementSetId]);
  async function flush(release = false) {
    const current = draftRef.current;
    if (saving.current) { releaseRequested.current ||= release; return; }
    if (!current || current.conflict) return;
    if (latest.current.connection !== 'connected') { setError('Reconnecting. Your draft is saved on this computer.'); return; }
    const values = changedValues(current.baseValues, current.values);
    if (current.itemId && !Object.keys(values).length) { if (release) { await collab({ action: 'lock', kind: 'release', key: `item:${current.itemId}` }); updateDraft(null); setPresence({ focus: null, drafting: null }); } return; }
    saving.current = true; setError('');
    try {
      const result = await collab({ action: 'op', op: current.itemId
        ? { opId: crypto.randomUUID(), kind: 'item.edit', payload: { objectType, requirementSetId, itemId: current.itemId, values } }
        : { opId: current.opId ?? crypto.randomUUID(), kind: 'item.add', payload: { objectType, requirementSetId, values: current.values } } });
      const itemId = current.itemId ?? result.result.createdId;
      if (draftRef.current === current) {
        if (release) { await collab({ action: 'lock', kind: 'release', key: `item:${itemId}` }); updateDraft(null); setPresence({ focus: null, drafting: null }); }
        else updateDraft({ ...current, itemId, baseValues: current.values });
      } else if (draftRef.current) updateDraft({ ...draftRef.current, itemId, baseValues: current.values });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save draft'); }
    finally { saving.current = false; if (releaseRequested.current) { releaseRequested.current = false; void flush(true); } }
  }
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (draft?.itemId && !draft.conflict && Object.keys(changedValues(draft.baseValues, draft.values)).length && canEdit) timer.current = setTimeout(() => { void flush(); }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [draft, canEdit]);
  async function begin(itemId: string | null, column?: string) {
    if (latest.current.draft && (latest.current.draft.requirementSetId !== requirementSetId || latest.current.draft.kind === 'description')) throw new Error('A draft is kept in another requirement set. Save or cancel that draft first.');
    if (draftRef.current) { await flush(true); if (draftRef.current) throw new Error('Save or cancel your current draft first.'); }
    if (!canEdit || !set) return;
    const item = set.items.find(i => i.id === itemId);
    if (itemId) await collab({ action: 'lock', kind: 'acquire', key: `item:${itemId}` });
    const values = item?.values ?? Object.fromEntries(columns.filter(c => c.default !== undefined).map(c => [c.id, c.default!]));
    updateDraft({ opId: crypto.randomUUID(), objectType, requirementSetId, itemId, values: { ...values }, baseValues: item ? { ...values } : {} });
    setPresence({ focus: itemId && column ? { itemId, columnId: column } : null, drafting: itemId ? null : requirementSetId });
    setFocusColumn(column ?? columns[0]?.id ?? null);
  }
  async function cancel() { if (draftRef.current?.itemId) await collab({ action: 'lock', kind: 'release', key: `item:${draftRef.current.itemId}` }).catch(() => {}); updateDraft(null); setError(''); setPresence({ focus: null, drafting: null }); }
  async function saveScope() { if (scopeRef.current === null || !canEdit || latest.current.draft?.conflict) return; const saved = scopeRef.current; await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'requirementSet.description', payload: { objectType, requirementSetId, description: saved } } }); if (scopeRef.current === saved) await collab({ action: 'clear-draft' }); }
  useEffect(() => { if (scope === null || !canEdit) return; const timeout = setTimeout(() => { void saveScope().catch(e => setError(String(e))); }, 300); return () => clearTimeout(timeout); }, [scope, canEdit]);
  // The row can mount before its lock reaches this window; focus the clicked field once it is editable.
  const rowEditable = !!draft && canEdit && !draft.conflict && (!draft.itemId || lockStatus(state.locks[`item:${draft.itemId}`], state.sessionKey) === 'mine');
  useEffect(() => {
    const fields = draftFields.current;
    if (!rowEditable || !fields || fields.contains(document.activeElement)) return;
    (fields.querySelector<HTMLElement>(`[data-column="${focusColumn}"] input, [data-column="${focusColumn}"] textarea, [data-column="${focusColumn}"] select, [data-column="${focusColumn}"] button`) ?? fields.querySelector<HTMLElement>('input, textarea, select'))?.focus();
  }, [rowEditable, draft?.itemId, focusColumn]);
  if (!set) return <Panel title="This requirement set was removed" icon="warning" tone="danger">{draft ? <><p>Your draft is kept. Copy it before dismissing.</p><pre>{JSON.stringify(draft.values, null, 2)}</pre><Button onClick={() => void cancel()}>Dismiss draft</Button></> : <p>Someone deleted it. Pick another node in the tree.</p>}</Panel>;
  const rows = set.items.filter(i => `${i.id} ${Object.values(i.values).join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  const others = peers(state);
  const adders = others.filter(p => p.state.drafting === requirementSetId);
  const scopeKey = `rs-desc:${requirementSetId}`;
  const scopeHolder = state.locks[scopeKey];
  const scopeState = lockStatus(scopeHolder, state.sessionKey);
  const why = paused ? 'Paused while project settings change' : !cap.edit ? (state.role === 'VIEWER' ? 'Viewers cannot edit' : 'Reconnecting…') : '';
  const editorRow = (title: React.ReactNode) => draft && <tr className="draft-row"><td colSpan={columns.length + 3}>
    <section className="row-draft" aria-label="Item draft">
      <header><Icon name={draft.itemId ? 'edit' : 'plus'} /><strong>{title}</strong>{draft.itemId && <span className="hint">Changes save as you type</span>}</header>
      {draft.conflict && <Alert>{draft.conflict}<div className="conflict-cols"><div><h4>Your draft</h4><pre>{JSON.stringify(draft.values, null, 2)}</pre></div><div><h4>Current row</h4><pre>{JSON.stringify(set.items.find(i => i.id === draft.itemId)?.values ?? 'Deleted', null, 2)}</pre></div></div>
        {set.items.some(i => i.id === draft.itemId) && <Button icon="refresh" disabled={!canEdit} onClick={() => run(async () => { await collab({ action: 'lock', kind: 'acquire', key: `item:${draft.itemId}` }); updateDraft({ ...draft, baseValues: set.items.find(i => i.id === draft.itemId)!.values, conflict: undefined }); })}>Reapply my draft</Button>}</Alert>}
      <fieldset ref={draftFields} disabled={!rowEditable} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && draft.itemId) void flush(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void cancel(); } if (event.key === 'Enter' && (event.ctrlKey || !(event.target instanceof HTMLTextAreaElement))) { event.preventDefault(); void flush(true); } }}>
        <div className="draft-fields">{columns.map(column => <label key={column.id} data-column={column.id} className={`field${['text', 'markdown'].includes(column.type) ? ' wide' : ''}`} onFocus={() => setPresence({ focus: draft.itemId ? { itemId: draft.itemId, columnId: column.id } : null, drafting: draft.itemId ? null : requirementSetId })}>
          <span className="field-label"><Icon name={columnIcons[column.type]} size={12} />{column.name}{column.required && <span className="req">*</span>}</span>
          <FieldEditor column={column} value={draft.values[column.id]} targets={targets} autoFocus={focusColumn === column.id} onChange={value => updateDraft({ ...draftRef.current!, values: { ...draftRef.current!.values, [column.id]: value } })} />
        </label>)}</div>
        <div className="draft-actions"><span className="hint"><kbd>Enter</kbd> {draft.itemId ? 'save & close' : 'add'} · <kbd>Esc</kbd> cancel</span><ButtonGroup label="Draft"><Button icon="undo" onClick={() => run(cancel)}>Cancel</Button><Button tone="primary" icon={draft.itemId ? 'check' : 'plus'} onClick={() => void flush(true)}>{draft.itemId ? 'Save and close' : 'Add item'}</Button></ButtonGroup></div>
      </fieldset>
    </section></td></tr>;
  return <>
    <Panel title="Scope" icon="paragraph" className={`scope-panel${scopeState === 'others' ? ' held' : ''}`} actions={scope === null
      ? <Button icon="edit" disabled={!canEdit || scopeState === 'others'} title={scopeState === 'others' ? `${holderName(state, scopeHolder!)} is editing the scope` : why} onClick={() => run(async () => { if (latest.current.draft && latest.current.draft.kind !== 'description') throw new Error('Save or cancel the current item draft first.'); await collab({ action: 'lock', kind: 'acquire', key: scopeKey }); scopeRef.current = set.description; setScope(set.description); })}>Edit scope</Button>
      : <><div className="segmented" role="tablist"><button role="tab" aria-selected={!scopePreview} className={!scopePreview ? 'on' : ''} onClick={() => setScopePreview(false)}>Write</button><button role="tab" aria-selected={scopePreview} className={scopePreview ? 'on' : ''} onClick={() => setScopePreview(true)}>Preview</button></div>
        <Button tone="primary" icon="check" onClick={() => run(async () => { await saveScope(); await collab({ action: 'lock', kind: 'release', key: scopeKey }); if (latest.current.draft?.conflict) return; await collab({ action: 'clear-draft' }); scopeRef.current = null; setScope(null); })}>Done</Button></>}>
      {scopeState === 'others' && scopeHolder && <div className="held-banner" style={{ '--user': scopeHolder.color } as React.CSSProperties}><Avatar name={scopeHolder.name} color={scopeHolder.color} size="sm" /><span><strong>{holderName(state, scopeHolder)}</strong> is writing the scope<span className="typing"><i /><i /><i /></span></span><Icon name="lock" size={14} /></div>}
      {scope === null || scopePreview ? <ScopeMarkdown text={scope ?? set.description} />
        : <textarea className="scope-input" aria-label="Requirement set scope" disabled={!canEdit || scopeState !== 'mine'} rows={6} value={scope} autoFocus onChange={e => { scopeRef.current = e.target.value; setScope(e.target.value); void collab({ action: 'draft', draft: { kind: 'description', objectType, requirementSetId, itemId: null, values: { description: e.target.value }, baseValues: { description: latest.current.workspace!.domains[objectType].requirementSets.find(s => s.requirementSetId === requirementSetId)!.description } } }).catch(e => setError(String(e))); }} />}
      {state.draft?.kind === 'description' && state.draft.conflict && <Alert><p>{state.draft.conflict}</p><pre>{String(state.draft.values.description)}</pre><h4>Current scope</h4><pre>{set.description}</pre><Button icon="refresh" onClick={() => run(async () => { await collab({ action: 'lock', kind: 'acquire', key: scopeKey }); await collab({ action: 'draft', draft: { ...state.draft!, conflict: undefined, baseValues: { description: set.description } } }); })}>Reapply my scope</Button></Alert>}
    </Panel>
    <Panel className="items-panel" title={<>{objectLabels[objectType]} <span className="count">{set.items.length}</span></>} icon="list" actions={<>
      <label className="filter-box"><Icon name="search" size={14} /><input type="search" aria-label="Search items" placeholder="Filter items" value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }} /></label>
      <ButtonGroup label="Author"><Button tone="primary" icon="plus" disabled={!canEdit || !!draft} title={why} onClick={() => run(() => begin(null))}>{objectType === 'REQUIREMENT' ? 'Add requirement' : 'Add item'}</Button></ButtonGroup>
    </>}>
      {why && !paused && <Alert tone="info" icon="eye">{why}. You can still read everything.</Alert>}
      {error && <Alert onDismiss={() => setError('')}>{error}</Alert>}
      <div className="table-scroll"><table className="grid room-grid"><thead><tr><th className="col-id"><Icon name="hash" size={12} />ID</th>{columns.map(c => <th key={c.id}><Icon name={columnIcons[c.type]} size={12} />{c.name}{c.required && <span className="req">*</span>}</th>)}<th className="col-who"><Icon name="users" size={12} /><span className="sr-only">Editing</span></th><th className="col-actions"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.slice(offset, offset + PAGE).map(item => {
          const holder = state.locks[`item:${item.id}`];
          const status = lockStatus(holder, state.sessionKey);
          if (status === 'mine' && draft?.itemId === item.id) return <React.Fragment key={item.id}>{editorRow(<><Code>{item.id}</Code> editing</>)}</React.Fragment>;
          const focus = holder && status === 'others' ? others.find(p => p.user.userId === holder.userId && p.state.focus?.itemId === item.id)?.state.focus?.columnId : undefined;
          return <tr key={item.id} className={status === 'others' ? 'held-row' : ''} style={holder && status === 'others' ? { '--user': holder.color } as React.CSSProperties : undefined}>
            <td className="col-id"><Code>{item.id}</Code></td>
            {columns.map(c => <td key={c.id} className={focus === c.id ? 'held-cell' : ''}>
              {focus === c.id && holder && <span className="cell-flag">{holder.name.split(' ')[0]}</span>}
              <button className="cell-edit" disabled={!canEdit || status === 'others' || !!draft} aria-label={`Edit ${c.name} for ${item.id}`} title={status === 'others' ? `${holderName(state, holder!)} is editing this row` : String(item.values[c.id] ?? '')} onClick={() => run(() => begin(item.id, c.id))}>{displayValue(c, item.values[c.id]) || <span className="muted">—</span>}</button>
            </td>)}
            <td className="col-who">{holder && status === 'others' && <span className="who"><Avatar name={holder.name} color={holder.color} size="sm" /><small>{holderName(state, holder)}</small></span>}</td>
            <td className="col-actions"><span className="row-actions">
              <IconButton icon="edit" label={`Edit ${item.id}`} disabled={!canEdit || status === 'others' || !!draft} onClick={() => run(() => begin(item.id))} />
              <IconButton icon="trash" tone="danger" label={`Delete ${item.id}`} disabled={!canEdit || !!draft || status === 'others'} onClick={() => run(async () => { if (await confirm({ title: `Delete ${item.id}?`, tone: 'danger', icon: 'trash', confirmLabel: 'Delete permanently', body: <p>The ID is retired forever and nobody can reuse it.</p> })) await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'item.delete', payload: { objectType, requirementSetId, itemId: item.id } } }); })} />
            </span></td>
          </tr>;
        })}
        {draft && !draft.itemId && editorRow(<>New item <span className="hint">· gets {nextId} when added</span></>)}
        {adders.map(p => <tr key={p.connectionId} className="ghost-row" style={{ '--user': p.user.color } as React.CSSProperties}><td colSpan={columns.length + 3}><Avatar name={p.user.name} color={p.user.color} size="sm" /><span><strong>{p.user.name}</strong> is writing a new item</span><span className="typing"><i /><i /><i /></span></td></tr>)}
        </tbody></table></div>
      {!set.items.length && !draft && !adders.length && <div className="table-empty"><Icon name="requirement" size={28} /><span>No items yet. The first one gets <Code>{nextId}</Code>.</span></div>}
      {rows.length > PAGE && <div className="pager"><IconButton icon="arrowUp" label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} /><span>{Math.min(offset + 1, rows.length)}–{Math.min(offset + PAGE, rows.length)} of {rows.length}</span><IconButton icon="arrowDown" label="Next page" disabled={offset + PAGE >= rows.length} onClick={() => setOffset(offset + PAGE)} /></div>}
      {set.items.length > 0 && <div className="legend"><Badge tone="muted" icon="lock">Rows in color are being edited by that person</Badge></div>}
    </Panel>
  </>;
}
