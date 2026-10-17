import React, { useCallback, useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import type { HierarchySelection } from '../../../shared/hierarchy.js';
import { capabilities, presenceByNode } from '../../../shared/collab/ui.js';
import { WorkspaceTree } from '../tree/WorkspaceTree.js';
import { HierarchyDialog, type HierarchyEditor } from '../tree/HierarchyDialog.js';
import { ProjectSettings } from '../settings/ProjectSettings.js';
import { ServerConnectView } from './ServerConnectView.js';
import { RoomLobby } from './RoomLobby.js';
import { RoomEditor } from './RoomEditor.js';
import { RoomMembersModal } from './RoomMembersModal.js';
import { RevisionsModal } from './RevisionsModal.js';
import { collab } from './api.js';
export function Collaboration({ onOffline }: { onOffline: () => void }) {
  const [state, setState] = useState<CollabState>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<HierarchySelection | null>(null); const [editor, setEditor] = useState<HierarchyEditor | null>(null);
  const [panel, setPanel] = useState<'edit'|'members'|'revisions'|'settings'>('edit');
  const run = useCallback((fn: () => Promise<unknown>) => { setBusy(true); setError(''); void fn().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }, []);
  useEffect(() => { const off = window.hlr.onCollabState(setState); void collab({ action: 'state' }).then(setState); return off; }, []);
  useEffect(() => { setSelected(null); setPanel('edit'); }, [state?.roomId]);
  function mayLeave() { if (panel === 'settings') { setError('Save or cancel project settings before leaving this view.'); return false; } return !state?.draft || window.confirm('Your draft is saved on this computer. Leave this view?'); }
  const cap = capabilities(state?.role ?? null, state?.connection === 'connected');
  if (!state) return <p>Loading collaboration…</p>;
  const peers = presenceByNode(state.presence);
  const navigate = (s: HierarchySelection) => { if (!mayLeave()) return; setSelected(s); setPanel('edit'); void collab({ action: 'presence', view: s.id ? { objectType: s.objectType, nodeId: s.id } : null, focus: null, drafting: null }); };
  return <div className="app collab-app"><header><div className="brand"><span className="brand-mark">H</span><strong>HLR <span>Team workspace</span></strong></div><span className="project-title">{state.workspace?.config.projectName ?? state.server?.name ?? 'Connect to a server'}</span><button onClick={() => { if (mayLeave()) run(async () => { await collab({ action: 'leave' }); onOffline(); }); }}>Work offline</button>{state.roomId && <button onClick={() => { if (mayLeave()) run(() => collab({ action: 'leave' })); }}>Room lobby</button>}</header>
    {error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>Dismiss</button></div>}{state.notice && <p className="notice" role="status">{state.notice}</p>}
    {state.roomId && state.connection !== 'connected' && <div role="alert" className="connection-banner">{state.connection === 'reconnecting' || state.connection === 'connecting' ? 'Reconnecting…' : 'Disconnected'} Edits are paused. Your draft is preserved.</div>}
    {!state.user ? <main><ServerConnectView state={state} run={run} /></main> : !state.roomId ? <main><RoomLobby state={state} run={run} /></main> : !state.workspace ? <main><p>Opening room…</p></main> : <><div className="collab-toolbar"><span>{state.role}</span><span>{new Set(state.presence.map(p => p.user.userId)).size} online</span><button onClick={() => { if (mayLeave()) setPanel('members'); }}>Members</button><button onClick={() => { if (mayLeave()) setPanel('revisions'); }}>Revisions</button><button onClick={() => run(() => collab({ action: 'export' }))}>Export local copy</button>{cap.admin && <button onClick={() => run(async () => { if (!mayLeave()) return; await collab({ action: 'lock', kind: 'acquire', key: 'config' }); setPanel('settings'); })}>Project settings</button>}</div>
    <div className="body"><aside><WorkspaceTree workspace={state.workspace} selected={selected} busy={false} readOnly={!cap.edit} allowDelete={cap.admin} presence={Object.fromEntries(Object.entries(peers).map(([id, p]) => [id, p.map(e => e.user.name).join(', ')]))} onSelect={navigate} onAction={(action, selection) => { if (!mayLeave() || !cap.edit || action === 'delete' && !cap.admin) return; run(async () => { if (action === 'edit' && selection.id) await collab({ action: 'lock', kind: 'acquire', key: `node:${selection.id}` }); setEditor({ action, selection }); }); }} /></aside><main aria-busy={busy}>
      {panel === 'members' ? <RoomMembersModal state={state} run={run} close={() => setPanel('edit')} /> : panel === 'revisions' ? <RevisionsModal state={state} run={run} close={() => setPanel('edit')} /> : panel === 'settings' ? <ProjectSettings current={state.workspace.config} busy={!cap.admin || state.locks.config?.userId !== state.user.id} onDraft={() => {}} onCancel={() => run(async () => { await collab({ action: 'lock', kind: 'release', key: 'config' }); setPanel('edit'); })} onSave={async config => { await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'config.update', payload: config } }); await collab({ action: 'lock', kind: 'release', key: 'config' }); setPanel('edit'); }} />
      : selected?.kind === 'function' && selected.id ? <RoomEditor key={`${state.roomId}:${selected.id}`} state={state} objectType={selected.objectType} functionId={selected.id} run={run} /> : <section><h1>{selected?.id ? state.workspace.domains[selected.objectType].modules.find(m => m.id === selected.id)?.name : 'Room workspace'}</h1><p>Select a function to write requirements, or use the tree menu to create modules and functions.</p>{state.draft && <div className="notice"><p>You have a preserved draft.</p><button onClick={() => navigate({ objectType: state.draft!.objectType, kind: 'function', id: state.draft!.functionId })}>Open draft</button></div>}<h2>Online now</h2>{state.presence.map(p => <p key={p.connectionId}><span style={{ color: p.user.color }}>●</span> {p.user.name}{p.state.drafting ? ' — adding an item' : ''}</p>)}</section>}
    </main></div>{editor && <HierarchyDialog workspace={state.workspace} editor={editor} busy={!cap.edit || busy} onClose={() => run(async () => { if (editor.action === 'edit') await collab({ action: 'lock', kind: 'release', key: `node:${editor.selection.id}` }); setEditor(null); })} onSave={async command => { await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'hierarchy', payload: command } }); if (editor.action === 'edit') await collab({ action: 'lock', kind: 'release', key: `node:${editor.selection.id}` }); setEditor(null); }} />}</>}
    <footer><span>{state.connection}</span><span>{state.autosave}</span><span>Changes shared with your room</span></footer></div>;
}
