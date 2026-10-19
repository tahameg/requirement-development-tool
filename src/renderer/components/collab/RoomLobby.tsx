import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import { collab, request } from './api.js';
import { ServerAdmin } from './ServerAdmin.js';
import { Icon } from '../ui/Icon.js';
import { Badge, Button, ButtonGroup, Empty, Eyebrow, Field, IconButton, Panel } from '../ui/primitives.js';
export function RoomLobby({ state, run }: { state: CollabState; run: (fn: () => Promise<unknown>) => void }) {
  const [lobby, setLobby] = useState<any>(null); const [admin, setAdmin] = useState(false);
  const refresh = async () => setLobby(await request('GET', '/api/rooms'));
  useEffect(() => { run(refresh); const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000); return () => clearInterval(timer); }, []);
  const canCreate = state.server?.roomCreationMode !== 'admins_only' || state.user?.serverRole !== 'USER';
  return <section className="lobby">
    <header className="lobby-head"><div><Eyebrow icon="server">{state.server?.name}</Eyebrow><h1>Your rooms</h1><p>Signed in as <strong>{state.user?.displayName}</strong></p></div>
      <ButtonGroup label="Lobby"><IconButton icon="refresh" label="Refresh" onClick={() => run(refresh)} />{state.user?.serverRole !== 'USER' && <Button icon="shield" className={admin ? 'on' : ''} onClick={() => setAdmin(!admin)}>Server administration</Button>}</ButtonGroup>
      <ButtonGroup label="Account"><Button icon="logout" onClick={() => run(() => collab({ action: 'disconnect' }))}>Sign out</Button></ButtonGroup>
    </header>
    {admin && <ServerAdmin state={state} run={run} />}
    <div className="room-grid-tiles">{lobby?.myRooms.map((room: any) => <button className="room-tile" key={room.id} onClick={() => run(() => collab({ action: 'join', roomId: room.id }))}>
      <span className="room-tile-top"><Icon name="grid" size={22} /><Badge tone={room.onlineCount ? 'ok' : 'muted'}>{room.onlineCount ?? 0} online</Badge></span>
      <strong>{room.name}</strong><small>{room.projectName}</small><span className="room-role"><Icon name={room.myRole === 'ROOM_OWNER' ? 'crown' : room.myRole === 'VIEWER' ? 'eye' : 'edit'} size={12} />{String(room.myRole).replace('ROOM_', '').toLowerCase()}</span>
    </button>)}</div>
    {lobby && !lobby.myRooms.length && <Empty icon="grid" title="No rooms yet">Create one, redeem an invite code, or ask to join a listed room.</Empty>}
    <div className="lobby-columns">
      {canCreate && <Panel title="Create a room" icon="plus"><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); run(async () => { const result = data.get('source') === 'local' ? await collab({ action: 'create-from-local', name: String(data.get('name')), visibility: data.get('visibility') as 'private' | 'listed' }) : await request('POST', '/api/rooms', { name: data.get('name'), visibility: data.get('visibility'), projectName: data.get('name'), projectPrefix: data.get('prefix') }); if (result) await collab({ action: 'join', roomId: result.room.id }); }); }}>
        <Field label="Room and project name"><input name="name" required /></Field>
        <div className="form-row"><Field label="Starting content" className="grow"><select name="source"><option value="empty">New empty project</option><option value="local">Choose a local workspace</option></select></Field><Field label="Prefix" className="prefix-field"><input name="prefix" className="mono" defaultValue="GS" /></Field></div>
        <Field label="Visibility"><select name="visibility"><option value="private">Private: invite only</option><option value="listed">Listed: people can ask to join</option></select></Field>
        <div className="form-actions"><Button type="submit" tone="primary" icon="plus">Create room</Button></div>
      </form></Panel>}
      <Panel title="Invite code" icon="key"><form onSubmit={e => { e.preventDefault(); const code = new FormData(e.currentTarget).get('code'); run(async () => { await request('POST', '/api/invites/redeem', { code }); await refresh(); }); }}>
        <Field label="Code from a room admin"><input name="code" className="mono" required /></Field><div className="form-actions"><Button type="submit" icon="key">Join with code</Button></div>
      </form></Panel>
    </div>
    <div className="lobby-columns">
      <Panel title="Invitations" icon="mail">{lobby?.myInvites.length ? lobby.myInvites.map((invite: any) => <div className="list-row" key={invite.id}><Icon name="mail" /><span><strong>{invite.roomName}</strong><small>as {invite.role.toLowerCase()}</small></span>
        <ButtonGroup label="Respond"><Button tone="primary" icon="check" onClick={() => run(async () => { await request('POST', `/api/invites/${invite.id}/respond`, { accept: true }); await refresh(); })}>Accept</Button><IconButton icon="close" tone="danger" label="Decline" onClick={() => run(async () => { await request('POST', `/api/invites/${invite.id}/respond`, { accept: false }); await refresh(); })} /></ButtonGroup></div>) : <p className="hint">No pending invitations.</p>}</Panel>
      <Panel title="Listed rooms" icon="eye">{lobby?.listedRooms.length ? lobby.listedRooms.map((room: any) => <div className="list-row" key={room.id}><Icon name="grid" /><span><strong>{room.name}</strong></span><Button icon="arrowRight" onClick={() => run(async () => { await request('POST', `/api/rooms/${room.id}/join-requests`, { message: 'I would like to join this room.' }); await refresh(); })}>Request access</Button></div>) : <p className="hint">No listed rooms to join.</p>}
        {lobby?.myJoinRequests.length > 0 && <><h3 className="sub">Your requests</h3>{lobby.myJoinRequests.map((r: any) => <div className="list-row" key={r.id}><Icon name="history" /><span>{r.roomName}</span><Badge tone={r.status === 'APPROVED' ? 'ok' : r.status === 'REJECTED' ? 'danger' : 'muted'}>{r.status.toLowerCase()}</Badge></div>)}</>}
      </Panel>
    </div>
  </section>;
}
