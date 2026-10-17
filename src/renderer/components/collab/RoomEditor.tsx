import React, { useEffect, useRef, useState } from 'react';
import type { CollabState, RoomDraft } from '../../../shared/collab/client.js';
import type { ObjectType } from '../../../shared/types/config.js';
import { capabilities, changedValues, lockStatus } from '../../../shared/collab/ui.js';
import { referenceTargets } from '../../../shared/references.js';
import { FieldEditor } from '../editor/FieldEditor.js';
import { collab } from './api.js';
export function RoomEditor({ state, objectType, functionId, run }: { state: CollabState; objectType: ObjectType; functionId: string; run: (fn: () => Promise<unknown>) => void }) {
  const fn = state.workspace!.domains[objectType].functions.find(f => f.functionId === functionId);
  const columns = state.workspace!.config.objectTypes[objectType].columns;
  const cap = capabilities(state.role, state.connection === 'connected');
  const initial = state.draft?.functionId === functionId && state.draft.kind !== 'description' ? state.draft : null;
  const [draft, setDraftState] = useState<RoomDraft | null>(initial); const draftRef = useRef(draft); const saving = useRef(false); const releaseRequested = useRef(false);
  const [scope, setScope] = useState<string | null>(state.draft?.kind === 'description' && state.draft.functionId === functionId ? String(state.draft.values.description) : null); const scopeRef = useRef<string | null>(scope);
  const [error, setError] = useState(''); const [offset, setOffset] = useState(0); const [filter, setFilter] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(state); latest.current = state;
  function updateDraft(next: RoomDraft | null) { draftRef.current = next; setDraftState(next); void collab(next ? { action: 'draft', draft: next } : { action: 'clear-draft' }).catch(e => setError(String(e))); }
  useEffect(() => { if (state.draft?.conflict && draftRef.current) { draftRef.current = { ...draftRef.current, conflict: state.draft.conflict }; setDraftState(draftRef.current); } }, [state.draft?.conflict]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (draftRef.current || scopeRef.current !== null) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); if (timer.current) clearTimeout(timer.current); const id = draftRef.current?.itemId; if (id) void collab({ action: 'lock', kind: 'release', key: `item:${id}` }).catch(() => {}); if (scopeRef.current !== null) void collab({ action: 'lock', kind: 'release', key: `fn-desc:${functionId}` }).catch(() => {}); };
  }, [functionId]);
  async function flush(release = false) {
    const current = draftRef.current;
    if (saving.current) { releaseRequested.current ||= release; return; }
    if (!current || current.conflict) return;
    if (latest.current.connection !== 'connected') { setError('Reconnecting. Your draft is saved on this computer.'); return; }
    const values = changedValues(current.baseValues, current.values);
    if (current.itemId && !Object.keys(values).length) { if (release) { await collab({ action: 'lock', kind: 'release', key: `item:${current.itemId}` }); updateDraft(null); } return; }
    saving.current = true; setError('');
    try {
      const result = await collab({ action: 'op', op: current.itemId
        ? { opId: crypto.randomUUID(), kind: 'item.edit', payload: { objectType, functionId, itemId: current.itemId, values } }
        : { opId: current.opId ?? crypto.randomUUID(), kind: 'item.add', payload: { objectType, functionId, values: current.values } } });
      const itemId = current.itemId ?? result.result.createdId;
      if (draftRef.current === current) {
        if (release) { await collab({ action: 'lock', kind: 'release', key: `item:${itemId}` }); updateDraft(null); }
        else updateDraft({ ...current, itemId, baseValues: current.values });
      } else if (draftRef.current) updateDraft({ ...draftRef.current, itemId, baseValues: current.values });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save draft'); }
    finally { saving.current = false; if (releaseRequested.current) { releaseRequested.current = false; void flush(true); } }
  }
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (draft?.itemId && !draft.conflict && Object.keys(changedValues(draft.baseValues, draft.values)).length && cap.edit) timer.current = setTimeout(() => { void flush(); }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [draft, cap.edit]);
  async function begin(itemId: string | null) {
    if (latest.current.draft && (latest.current.draft.functionId !== functionId || latest.current.draft.kind === 'description')) throw new Error('A draft is preserved in another function. Save or cancel that draft before starting another.');
    if (draftRef.current) { await flush(true); if (draftRef.current) throw new Error('Save or cancel your current draft first.'); }
    if (!cap.edit || !fn) return;
    const item = fn.items.find(i => i.id === itemId);
    if (itemId) await collab({ action: 'lock', kind: 'acquire', key: `item:${itemId}` });
    const values = item?.values ?? Object.fromEntries(columns.filter(c => c.default !== undefined).map(c => [c.id, c.default!]));
    updateDraft({ opId: crypto.randomUUID(), objectType, functionId, itemId, values: { ...values }, baseValues: item ? { ...values } : {} });
    await collab({ action: 'presence', view: { objectType, nodeId: functionId }, focus: null, drafting: itemId ? null : functionId });
  }
  async function cancel() { if (draftRef.current?.itemId) await collab({ action: 'lock', kind: 'release', key: `item:${draftRef.current.itemId}` }).catch(() => {}); updateDraft(null); setError(''); }
  async function saveScope() { if (scopeRef.current === null || !cap.edit || latest.current.draft?.conflict) return; const saved = scopeRef.current; await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'function.description', payload: { objectType, functionId, description: saved } } }); if (scopeRef.current === saved) await collab({ action: 'clear-draft' }); }
  useEffect(() => { if (scope === null || !cap.edit) return; const timeout = setTimeout(() => { void saveScope().catch(e => setError(String(e))); }, 300); return () => clearTimeout(timeout); }, [scope, cap.edit]);
  if (!fn) return <section><h2>This function was removed</h2>{draft && <><p>Your draft is preserved. Copy it before closing.</p><pre>{JSON.stringify(draft.values, null, 2)}</pre><button onClick={() => void cancel()}>Dismiss draft</button></>}</section>;
  const rows = fn.items.filter(i => `${i.id} ${Object.values(i.values).join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  const viewing = state.presence.filter(p => p.state.view?.nodeId === functionId);
  return <section className="room-editor"><div className="section-heading"><div><div className="eyebrow">{objectType.replaceAll('_', ' ')}</div><h1>{fn.name}</h1></div><button disabled={!cap.edit || !!draft} onClick={() => run(() => begin(null))}>Add item</button></div>
    <div className="presence-list">{viewing.map(p => <span key={p.connectionId} style={{ borderColor: p.user.color }}>{p.user.name}{p.state.drafting === functionId ? ' is adding an item' : ' is viewing'}</span>)}</div>
    <section className="scope-card"><h2>Function scope</h2>{scope === null ? <><p className="scope-text">{fn.description || 'No scope description yet.'}</p><button disabled={!cap.edit || lockStatus(state.locks[`fn-desc:${functionId}`], state.user?.id) === 'others'} onClick={() => run(async () => { if (latest.current.draft && latest.current.draft.kind !== 'description') throw new Error('Save or cancel the current item draft first.'); await collab({ action: 'lock', kind: 'acquire', key: `fn-desc:${functionId}` }); scopeRef.current = fn.description; setScope(fn.description); })}>Edit scope</button>{state.locks[`fn-desc:${functionId}`] && <small>Editing: {state.locks[`fn-desc:${functionId}`]!.name}</small>}</> : <><textarea aria-label="Function scope" disabled={!cap.edit || state.locks[`fn-desc:${functionId}`]?.userId !== state.user?.id} rows={5} value={scope} onChange={e => { scopeRef.current = e.target.value; setScope(e.target.value); void collab({ action: 'draft', draft: { kind: 'description', objectType, functionId, itemId: null, values: { description: e.target.value }, baseValues: { description: latest.current.workspace!.domains[objectType].functions.find(f => f.functionId === functionId)!.description } } }).catch(e => setError(String(e))); }} />{state.draft?.kind === 'description' && state.draft.conflict && <div className="error"><p>{state.draft.conflict}</p><pre>{String(state.draft.values.description)}</pre><h3>Current scope</h3><pre>{fn.description}</pre><button onClick={() => run(async () => { await collab({ action: 'lock', kind: 'acquire', key: `fn-desc:${functionId}` }); await collab({ action: 'draft', draft: { ...state.draft!, conflict: undefined, baseValues: { description: fn.description } } }); })}>Reapply my scope</button></div>}<button onClick={() => run(async () => { await saveScope(); await collab({ action: 'lock', kind: 'release', key: `fn-desc:${functionId}` }); if (latest.current.draft?.conflict) return; await collab({ action: 'clear-draft' }); scopeRef.current = null; setScope(null); })}>Done</button></>}</section>
    {error && <p role="alert" className="error">{error}</p>}
    {draft && <section className="row-draft" aria-label="Item draft"><h2>{draft.itemId ?? 'New item — ID assigned when saved'}</h2>{draft.conflict && <div role="alert"><p>{draft.conflict}</p><div className="collab-columns"><div><h3>Your draft</h3><pre>{JSON.stringify(draft.values, null, 2)}</pre></div><div><h3>Current row</h3><pre>{JSON.stringify(fn.items.find(i => i.id === draft.itemId)?.values ?? 'Deleted', null, 2)}</pre></div></div>{fn.items.some(i => i.id === draft.itemId) && <button disabled={!cap.edit} onClick={() => run(async () => { await collab({ action: 'lock', kind: 'acquire', key: `item:${draft.itemId}` }); updateDraft({ ...draft, baseValues: fn.items.find(i => i.id === draft.itemId)!.values, conflict: undefined }); })}>Reapply my draft</button>}</div>}
    <fieldset disabled={!cap.edit || !!draft.conflict || !!draft.itemId && state.locks[`item:${draft.itemId}`]?.userId !== state.user?.id} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && draft.itemId) void flush(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void cancel(); } if (event.key === 'Enter' && (event.ctrlKey || !(event.target instanceof HTMLTextAreaElement))) { event.preventDefault(); void flush(true); } }}>
    {columns.map(column => <label key={column.id} onFocus={() => { void collab({ action: 'presence', view: { objectType, nodeId: functionId }, focus: draft.itemId ? { itemId: draft.itemId, columnId: column.id } : null, drafting: draft.itemId ? null : functionId }); }}>{column.name}{column.required ? ' *' : ''}<FieldEditor column={column} value={draft.values[column.id]} targets={referenceTargets(state.workspace!)} onChange={value => updateDraft({ ...draftRef.current!, values: { ...draftRef.current!.values, [column.id]: value } })} /></label>)}
    <button className="primary" onClick={() => void flush(true)}>{draft.itemId ? 'Save and close' : 'Add item'}</button></fieldset><button onClick={() => run(cancel)}>Cancel edits</button></section>}
    <label>Search items<input type="search" value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }} /></label><div className="table-scroll"><table><thead><tr><th>ID</th>{columns.map(c => <th key={c.id}>{c.name}</th>)}<th>Editing</th><th>Actions</th></tr></thead><tbody>{rows.slice(offset, offset + 100).map(item => { const holder = state.locks[`item:${item.id}`]; return <tr key={item.id} style={holder ? { outline: `2px solid ${holder.color}` } : undefined}><td>{item.id}</td>{columns.map(c => <td key={c.id} style={state.presence.some(p => p.state.focus?.itemId === item.id && p.state.focus.columnId === c.id) && holder ? { background: holder.color + '30' } : undefined}>{String(item.values[c.id] ?? '')}</td>)}<td>{holder?.name}</td><td><button disabled={!cap.edit || lockStatus(holder, state.user?.id) === 'others'} onClick={() => run(() => begin(item.id))}>Edit</button><button disabled={!cap.edit || !!draft || lockStatus(holder, state.user?.id) === 'others'} onClick={() => run(async () => { if (window.confirm(`Delete ${item.id}? Its ID will be retired.`)) await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'item.delete', payload: { objectType, functionId, itemId: item.id } } }); })}>Delete</button></td></tr>; })}</tbody></table></div><div className="actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button><span>{Math.min(offset + 1, rows.length)}–{Math.min(offset + 100, rows.length)} of {rows.length}</span><button disabled={offset + 100 >= rows.length} onClick={() => setOffset(offset + 100)}>Next</button></div>
  </section>;
}
