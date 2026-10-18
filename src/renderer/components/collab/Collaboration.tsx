import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import type { LockHolder, PresenceState } from '../../../shared/collab/types.js';
import type { HierarchySelection } from '../../../shared/hierarchy.js';
import { capabilities } from '../../../shared/collab/ui.js';
import { plural } from '../../../shared/terminology.js';
import { WorkspaceTree, type TreeAction } from '../tree/WorkspaceTree.js';
import { HierarchyDialog, type HierarchyEditor } from '../tree/HierarchyDialog.js';
import { HierarchyView } from '../editor/HierarchyView.js';
import { ProjectSettings } from '../settings/ProjectSettings.js';
import { Brand, StatusBar } from '../layout/Shell.js';
import { Icon } from '../ui/Icon.js';
import { Alert, Avatar, AvatarStack, Badge, Button, ButtonGroup, Empty, IconButton } from '../ui/primitives.js';
import { Modal, useConfirm, useToast } from '../ui/Modal.js';
import { ServerConnectView } from './ServerConnectView.js';
import { RoomLobby } from './RoomLobby.js';
import { RoomEditor } from './RoomEditor.js';
import { RoomMembersModal } from './RoomMembersModal.js';
import { RevisionsModal } from './RevisionsModal.js';
import { activity, ghostNodes, holderName, isMine, nodeLocks, peers, uniquePeople, viewersByNode } from './presence.js';
import { collab } from './api.js';
type Panel = 'edit' | 'members' | 'revisions' | 'settings';
export function Collaboration({ onOffline }: { onOffline: () => void }) {
  const [state, setState] = useState<CollabState>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<HierarchySelection | null>(null); const [editor, setEditor] = useState<HierarchyEditor | null>(null);
  const [panel, setPanel] = useState<Panel>('edit');
  const settingsDirty = useRef(false);
  const presence = useRef<PresenceState>({ view: null, focus: null, drafting: null, creating: null });
  const confirm = useConfirm(); const notify = useToast();
  const run = useCallback((fn: () => Promise<unknown>) => { setBusy(true); setError(''); void fn().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }, []);
  const setPresence = useCallback((patch: Partial<PresenceState>) => { presence.current = { ...presence.current, ...patch }; void collab({ action: 'presence', ...presence.current }).catch(() => {}); }, []);
  useEffect(() => { const off = window.hlr.onCollabState(setState); void collab({ action: 'state' }).then(setState); return off; }, []);
  useEffect(() => { setSelected(null); setPanel('edit'); presence.current = { view: null, focus: null, drafting: null, creating: null }; }, [state?.roomId]);
  // A settings session belongs to whoever holds the config lock. Announce how it ended.
  const settingsHolder = state?.locks.config;
  const previousHolder = useRef<LockHolder | undefined>(undefined);
  useEffect(() => {
    const before = previousHolder.current; previousHolder.current = settingsHolder;
    if (!state) return;
    if (panel === 'settings' && !isMine(state, settingsHolder)) { setPanel('edit'); notify({ tone: 'danger', title: 'Your settings session ended', body: 'The lock was released or expired. Unsaved settings were discarded.' }); }
    if (before && !settingsHolder && !isMine(state, before) && !state.settingsChange) notify({ tone: 'info', icon: 'database', title: `${before.name} closed project settings`, body: 'Nothing changed. Carry on.' });
  }, [settingsHolder?.sessionKey]);
  // Every publish clones state, so the same change arrives several times before the ack lands.
  const shownChange = useRef('');
  useEffect(() => {
    const change = state?.settingsChange; if (!change) { shownChange.current = ''; return; }
    const key = `${state!.seq}:${JSON.stringify(change)}`; if (shownChange.current === key) return; shownChange.current = key;
    notify({ tone: change.draftValuesDropped.length ? 'danger' : 'accent', icon: 'database', title: 'Project settings were updated', sticky: change.draftValuesDropped.length > 0, body: <ul className="change-list">
      {change.columnsAdded.map(c => <li key={`+${c}`} className="change-add">New column: {c}</li>)}
      {change.columnsRemoved.map(c => <li key={`-${c}`} className="change-remove">Removed column: {c}</li>)}
      {change.draftValuesDropped.length > 0 && <li className="change-remove">Removed from your draft: {change.draftValuesDropped.join(', ')}</li>}
      {!change.columnsAdded.length && !change.columnsRemoved.length && <li>Naming rules or column details changed. Panels are up to date.</li>}
    </ul> });
    void collab({ action: 'ack-settings-change' });
  }, [state?.settingsChange && JSON.stringify(state.settingsChange)]);
  useEffect(() => { if (state?.notice) notify({ tone: 'info', title: state.notice }); }, [state?.notice]);
  if (!state) return <div className="app"><Empty icon="refresh" title="Loading collaboration…" /></div>;
  const cap = capabilities(state.role, state.connection === 'connected');
  const settingsMine = isMine(state, settingsHolder);
  const paused = !!settingsHolder && !settingsMine;
  async function mayLeave() {
    if (panel === 'settings') {
      if (settingsDirty.current && !await confirm({ title: 'Leave project settings?', tone: 'danger', icon: 'warning', confirmLabel: 'Discard and leave', cancelLabel: 'Keep editing', body: <p>Your unsaved changes are discarded and the room resumes for everyone.</p> })) return false;
      await collab({ action: 'lock', kind: 'release', key: 'config' }).catch(() => {});
      settingsDirty.current = false; setPanel('edit');
      return true;
    }
    return !state!.draft || await confirm({ title: 'Leave this view?', icon: 'save', confirmLabel: 'Leave', body: <p>Your draft is kept on this computer. Open it again from the room home.</p> });
  }
  const navigate = async (s: HierarchySelection) => {
    if (!await mayLeave()) return;
    setSelected(s); setPanel('edit');
    setPresence({ view: s.id ? { objectType: s.objectType, nodeId: s.id } : null, focus: null, drafting: null });
  };
  const openPanel = async (next: Panel) => { if (next !== panel && await mayLeave()) setPanel(next); };
  async function startSettings() {
    if (!await mayLeave()) return;
    const online = uniquePeople(peers(state!)).filter(p => p.id !== state!.user?.id);
    if (online.length && !await confirm({ title: 'Start a settings session?', icon: 'pause', confirmLabel: 'Pause the room', body: <><p>Columns and naming rules affect everyone, so the room pauses for {plural(online.length, 'collaborator')} until you save or discard. Their drafts stay on their computers.</p><div className="confirm-people">{online.map(p => <Avatar key={p.id} name={p.name} color={p.color} />)}</div></> })) return;
    run(async () => { await collab({ action: 'lock', kind: 'acquire', key: 'config' }); setPanel('settings'); });
  }
  // Not routed through run(): the room-wide busy flag must never disable the dialog as it mounts.
  async function treeAction(action: TreeAction, selection: HierarchySelection) {
    if (!cap.edit || paused || action === 'delete' && !cap.admin) return;
    if (!await mayLeave()) return;
    try {
      if (action === 'edit' && selection.id) await collab({ action: 'lock', kind: 'acquire', key: `node:${selection.id}` });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    if (action === 'addComponent' || action === 'addRequirementSet') setPresence({ creating: { objectType: selection.objectType, kind: action === 'addComponent' ? 'component' : 'requirementSet', parentId: selection.id, name: '' } });
    setEditor({ action, selection });
  }
  function closeEditor() {
    const closing = editor; setEditor(null); setPresence({ creating: null });
    if (closing?.action === 'edit') void collab({ action: 'lock', kind: 'release', key: `node:${closing.selection.id}` }).catch(() => {});
  }
  const others = peers(state);
  const online = uniquePeople(state.presence);
  const ghosts = ghostNodes(state);
  const viewers = viewersByNode(state);
  return <div className={`app collab-app${paused ? ' room-paused' : ''}`}>
    <header className="topbar">
      <Brand mode="Team" />
      <div className="topbar-project">{state.workspace ? <><strong>{state.workspace.config.projectName}</strong><span className="muted">{state.server?.name}</span></> : <span className="muted">{state.server?.name ?? 'Connect to a server'}</span>}</div>
      {state.roomId && <span className={`conn conn-${state.connection}`}><Icon name={state.connection === 'connected' ? 'check' : 'refresh'} size={12} />{state.connection}</span>}
      {state.workspace && <><AvatarStack people={online} max={5} />
        <ButtonGroup label="Room"><Button icon="users" className={panel === 'members' ? 'on' : ''} onClick={() => void openPanel('members')}>Members</Button><Button icon="history" className={panel === 'revisions' ? 'on' : ''} onClick={() => void openPanel('revisions')}>Revisions</Button></ButtonGroup>
        {cap.admin && <ButtonGroup label="Configure"><Button icon="database" className={panel === 'settings' ? 'on' : ''} disabled={paused || panel === 'settings'} onClick={() => void startSettings()}>Data definition</Button></ButtonGroup>}
        <ButtonGroup label="Copy"><IconButton icon="download" label="Export a local copy" onClick={() => run(() => collab({ action: 'export' }))} /></ButtonGroup></>}
      <ButtonGroup label="Leave">
        {state.roomId && <Button icon="grid" onClick={() => void mayLeave().then(ok => { if (ok) run(() => collab({ action: 'leave' })); })}>Lobby</Button>}
        <Button icon="logout" onClick={() => void mayLeave().then(ok => { if (ok) run(async () => { await collab({ action: 'leave' }); onOffline(); }); })}>Work offline</Button>
      </ButtonGroup>
    </header>
    {state.roomId && state.connection !== 'connected' && <div role="alert" className="connection-banner"><Icon name="offline" />{state.connection === 'reconnecting' || state.connection === 'connecting' ? 'Reconnecting…' : 'Disconnected.'} Edits are paused. Your draft is kept.</div>}
    {settingsMine && panel === 'settings' && <div className="session-banner" role="status"><Icon name="pause" /><strong>Settings session</strong><span>The room is paused for everyone until you save or discard.</span></div>}
    {error && <div className="page-alert"><Alert onDismiss={() => setError('')}>{error}</Alert></div>}
    {!state.user ? <main className="solo"><ServerConnectView state={state} run={run} /></main> : !state.roomId ? <main className="solo"><RoomLobby state={state} run={run} /></main> : !state.workspace ? <main className="solo"><Empty icon="refresh" title="Opening room…" /></main> : <div className="body">
      <aside className="sidebar">
        <nav className="side-nav"><button className={!selected && panel === 'edit' ? 'on' : ''} onClick={() => void mayLeave().then(ok => { if (ok) { setSelected(null); setPanel('edit'); setPresence({ view: null, focus: null, drafting: null }); } })}><Icon name="home" />Room home</button></nav>
        <div className="side-label">Workspace</div>
        <WorkspaceTree workspace={state.workspace} selected={panel === 'edit' ? selected : null} busy={false} readOnly={!cap.edit || paused} allowDelete={cap.admin} viewers={viewers} ghosts={ghosts} locks={nodeLocks(state)} onSelect={s => void navigate(s)} onAction={(a, s) => void treeAction(a, s)} />
        <div className="side-foot"><span className={`role-chip role-${state.role}`}><Icon name={state.role === 'ROOM_OWNER' ? 'crown' : state.role === 'ROOM_ADMIN' ? 'shield' : state.role === 'VIEWER' ? 'eye' : 'edit'} size={14} /></span><div><strong>{state.user.displayName}</strong><small>{state.role?.replace('ROOM_', '').toLowerCase()}</small></div></div>
      </aside>
      <main aria-busy={busy}>
        {panel === 'members' ? <RoomMembersModal state={state} run={run} close={() => setPanel('edit')} />
        : panel === 'revisions' ? <RevisionsModal state={state} run={run} close={() => setPanel('edit')} />
        : panel === 'settings' && settingsMine ? <ProjectSettings current={state.workspace.config} workspace={state.workspace} busy={busy} waiting={uniquePeople(others).filter(p => p.id !== state.user?.id)}
          onDraft={dirty => { settingsDirty.current = dirty; }} onCancel={() => void mayLeave()}
          onSave={async config => { await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'config.update', payload: config } }); await collab({ action: 'lock', kind: 'release', key: 'config' }); settingsDirty.current = false; setPanel('edit'); notify({ tone: 'ok', title: 'Project settings saved', body: 'The room is running again.' }); }} />
        : selected ? <HierarchyView workspace={state.workspace} selected={selected} busy={busy} readOnly={!cap.edit || paused} allowDelete={cap.admin} onSelect={s => void navigate(s)} onAction={(a, s) => void treeAction(a, s)} ghosts={ghosts} viewers={viewers}
          renderSet={(set, nextId) => <RoomEditor key={`${state.roomId}:${set.requirementSetId}`} state={state} objectType={selected.objectType} requirementSetId={set.requirementSetId} nextId={nextId} run={run} setPresence={setPresence} paused={paused} />} />
        : <RoomHome state={state} onOpen={s => void navigate(s)} />}
      </main>
    </div>}
    {editor && state.workspace && <HierarchyDialog workspace={state.workspace} editor={editor} busy={!cap.edit || paused} peers={ghosts} onClose={closeEditor}
      onNameChange={name => { if (presence.current.creating) setPresence({ creating: { ...presence.current.creating, name } }); }}
      onSave={async command => { await collab({ action: 'op', op: { opId: crypto.randomUUID(), kind: 'hierarchy', payload: command } }); closeEditor(); }} />}
    {paused && settingsHolder && <SettingsPause state={state} holder={settingsHolder} />}
    <StatusBar items={[
      { icon: state.connection === 'connected' ? 'check' : 'offline', text: state.connection, tone: state.connection === 'connected' ? 'ok' : 'danger' },
      { icon: 'save', text: state.autosave || 'Changes save continuously' },
      ...state.workspace ? [{ icon: 'users' as const, text: `${online.length} online` }] : [],
      ...paused ? [{ icon: 'pause' as const, text: 'Paused: project settings', tone: 'accent' as const }] : [],
    ]} />
  </div>;
}
/** Shown to everyone except the settings holder; the work underneath is kept, not discarded. */
function SettingsPause({ state, holder }: { state: CollabState; holder: LockHolder }) {
  return <Modal title={`${holderName(state, holder)} is changing project settings`} eyebrow="Room paused" icon="pause" onClose={() => {}} dismissable={false} labelledBy="pause-title" className="pause-modal" width="md">
    <div className="pause-stripes" aria-hidden="true" />
    <div className="pause-body">
      <Avatar name={holder.name} color={holder.color} size="lg" ring />
      <div><p>Columns and naming rules can change under everyone's work, so editing waits until they finish.</p>
        <ul className="pause-list"><li><Icon name="save" size={14} />{state.draft ? 'Your draft is kept on this computer.' : 'Nothing of yours is at risk.'}</li><li><Icon name="refresh" size={14} />Panels update automatically when they are done.</li><li><Icon name="eye" size={14} />You will see what changed.</li></ul></div>
    </div>
    <div className="pause-wait"><span className="typing"><i /><i /><i /></span>Waiting for {holder.name.split(' ')[0]}</div>
  </Modal>;
}
function RoomHome({ state, onOpen }: { state: CollabState; onOpen: (s: HierarchySelection) => void }) {
  const ws = state.workspace!;
  const people = state.presence;
  const totals = Object.values(ws.domains).reduce((t, d) => ({ sets: t.sets + d.requirementSets.length, items: t.items + d.requirementSets.reduce((n, s) => n + s.items.length, 0) }), { sets: 0, items: 0 });
  return <section className="room-home">
    <div className="hero"><div className="eyebrow"><Icon name="users" size={12} />Room</div><h1>{ws.config.projectName}</h1><p>{plural(totals.items, 'item')} in {plural(totals.sets, 'requirement set')}. Everything saves as you type.</p></div>
    {state.draft && <Alert tone="accent" icon="save"><strong>You have a kept draft.</strong> <Button icon="arrowRight" onClick={() => onOpen({ objectType: state.draft!.objectType, kind: 'requirementSet', id: state.draft!.requirementSetId })}>Open draft</Button></Alert>}
    <section className="panel"><header className="panel-head"><h2><Icon name="sparkle" />Happening now</h2><Badge>{people.length} connected</Badge></header>
      <ul className="activity">{people.map(p => <li key={p.connectionId} style={{ '--user': p.user.color } as React.CSSProperties}>
        <Avatar name={p.user.name} color={p.user.color} /><span><strong>{p.connectionId === state.connectionId ? 'You' : p.user.name}</strong> {activity(state, p)}</span>
        {p.state.view && p.connectionId !== state.connectionId && <IconButton icon="arrowRight" label={`Go to where ${p.user.name} is`} onClick={() => onOpen({ objectType: p.state.view!.objectType, kind: ws.domains[p.state.view!.objectType].requirementSets.some(s => s.requirementSetId === p.state.view!.nodeId) ? 'requirementSet' : 'component', id: p.state.view!.nodeId })} />}
      </li>)}</ul>
    </section>
    <p className="hint">Pick a component or requirement set in the tree to start writing. Right-click a node for create, rename and delete.</p>
  </section>;
}
