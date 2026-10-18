import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import { capabilities } from '../../../shared/collab/ui.js';
import { collab, request } from './api.js';
import { Icon } from '../ui/Icon.js';
import { Avatar, Badge, Button, ButtonGroup, Code, Field, IconButton, Panel } from '../ui/primitives.js';
import { useConfirm } from '../ui/Modal.js';
import { holderName } from './presence.js';
const roleIcon = (role: string) => role === 'ROOM_OWNER' ? 'crown' : role === 'ROOM_ADMIN' ? 'shield' : role === 'VIEWER' ? 'eye' : 'edit';
export function RoomMembersModal({ state, run, close }: { state: CollabState; run: (fn: () => Promise<unknown>) => void; close: () => void }) {
  const [detail, setDetail] = useState<any>(); const [directory, setDirectory] = useState<any[]>([]); const [code, setCode] = useState('');
  const base = `/api/rooms/${state.roomId}`; const cap = capabilities(state.role, state.connection === 'connected');
  const confirm = useConfirm();
  const refresh = async () => setDetail(await request('GET', base));
  useEffect(() => { run(refresh); }, [state.notice]);
  const mutate = (route: string, body?: unknown, method: 'POST'|'PATCH'|'DELETE' = 'POST') => run(async () => { await request(method, base + route, body); await refresh(); });
  const ask = async (title: string, body: string, label: string, then: () => void) => { if (await confirm({ title, tone: 'danger', confirmLabel: label, body: <p>{body}</p> })) then(); };
  const pendingInvites = detail?.invites.filter((i: any) => i.status === 'PENDING') ?? [];
  const pendingRequests = detail?.joinRequests.filter((r: any) => r.status === 'PENDING') ?? [];
  return <section className="page-panels" aria-label="Room members">
    <header className="page-head"><div><div className="eyebrow"><Icon name="users" size={12} />Room</div><h1>Members</h1></div><Button icon="close" onClick={close}>Close</Button></header>
    <Panel title="People" icon="users">{detail?.members.map((member: any) => { const online = state.presence.find(p => p.user.userId === member.userId); return <div className="member-row" key={member.userId}>
      <Avatar name={member.displayName} color={online?.user.color ?? '#777777'} /><span className="member-name"><strong>{member.displayName}</strong><small><span className={`dot ${online ? 'dot-on' : ''}`} />{online ? 'Online' : 'Offline'}</small></span>
      <Badge icon={roleIcon(member.role)}>{member.role.replace('ROOM_', '').toLowerCase()}</Badge>
      {cap.admin && member.role !== 'ROOM_OWNER' && member.userId !== state.user?.id && <>
        <select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={e => mutate(`/members/${member.userId}`, { role: e.target.value }, 'PATCH')}><option value="VIEWER">Viewer</option><option value="EDITOR">Editor</option>{cap.owner && <option value="ROOM_ADMIN">Admin</option>}</select>
        {cap.owner && <IconButton icon="crown" label={`Transfer ownership to ${member.displayName}`} onClick={() => void ask(`Transfer ownership to ${member.displayName}?`, 'You become a room admin.', 'Transfer', () => mutate('/transfer-ownership', { newOwnerUserId: member.userId }))} />}
        <ButtonGroup label="Remove"><IconButton icon="logout" tone="danger" label={`Remove ${member.displayName}`} onClick={() => void ask(`Remove ${member.displayName}?`, 'They can be invited again later.', 'Remove', () => mutate(`/members/${member.userId}/kick`, { reason: 'Removed by room administrator' }))} />
          <IconButton icon="ban" tone="danger" label={`Ban ${member.displayName}`} onClick={() => void ask(`Ban ${member.displayName}?`, 'They cannot rejoin until unbanned.', 'Ban', () => mutate(`/members/${member.userId}/ban`, { reason: 'Banned by room administrator' }))} /></ButtonGroup>
      </>}
    </div>; })}</Panel>
    {cap.admin && <div className="lobby-columns">
      <Panel title="Invite" icon="mail">
        <form onSubmit={e => { e.preventDefault(); const q = new FormData(e.currentTarget).get('query'); run(async () => setDirectory((await request('GET', `/api/users/directory?q=${encodeURIComponent(String(q))}`)).users)); }}><div className="form-row"><Field label="Find a server user" className="grow"><input name="query" required /></Field><Button type="submit" icon="search">Find</Button></div></form>
        {directory.map(u => <div className="list-row" key={u.id}><Icon name="user" /><span>{u.displayName}</span><ButtonGroup label="Invite as"><Button icon="edit" onClick={() => mutate('/invites', { targetUserId: u.id, role: 'EDITOR' })}>Editor</Button><Button icon="eye" onClick={() => mutate('/invites', { targetUserId: u.id, role: 'VIEWER' })}>Viewer</Button></ButtonGroup></div>)}
        <div className="invite-code"><Button icon="key" onClick={() => run(async () => { const result = await request('POST', base + '/invite-codes', { role: 'EDITOR', maxUses: 10, expiresInSeconds: 86400 }); setCode(result.inviteCode.code); await refresh(); })}>New invite code</Button><span className="hint">Editor role · 24 hours · 10 uses</span>{code && <Code big>{code}</Code>}</div>
      </Panel>
      <Panel title="Waiting" icon="history">
        <h3 className="sub">Join requests</h3>{pendingRequests.length ? pendingRequests.map((r: any) => <div className="list-row" key={r.id}><Icon name="user" /><span><strong>{r.displayName}</strong><small>{r.message}</small></span><ButtonGroup label="Approve"><Button tone="primary" icon="edit" onClick={() => mutate(`/join-requests/${r.id}/review`, { approve: true, role: 'EDITOR' })}>Editor</Button><Button icon="eye" onClick={() => mutate(`/join-requests/${r.id}/review`, { approve: true, role: 'VIEWER' })}>Viewer</Button></ButtonGroup><IconButton icon="close" tone="danger" label="Reject" onClick={() => mutate(`/join-requests/${r.id}/review`, { approve: false })} /></div>) : <p className="hint">None.</p>}
        <h3 className="sub">Pending invitations</h3>{pendingInvites.length ? pendingInvites.map((i: any) => <div className="list-row" key={i.id}><Icon name={i.code ? 'key' : 'mail'} /><span>{i.targetUsername ?? i.targetUserId ?? i.code}<small>{i.role.toLowerCase()}</small></span><IconButton icon="close" tone="danger" label="Revoke" onClick={() => mutate(`/invites/${i.id}`, undefined, 'DELETE')} /></div>) : <p className="hint">None.</p>}
        {detail?.bans.length > 0 && <><h3 className="sub">Banned</h3>{detail.bans.map((b: any) => <div className="list-row" key={b.userId}><Icon name="ban" /><span>{b.displayName ?? b.userId}</span><Button icon="undo" onClick={() => mutate(`/bans/${b.userId}`, undefined, 'DELETE')}>Unban</Button></div>)}</>}
      </Panel>
    </div>}
    {cap.admin && <Panel title="Active edit locks" icon="lock">{Object.keys(state.locks).length ? Object.entries(state.locks).map(([key, holder]) => <div className="list-row" key={key}><Avatar name={holder.name} color={holder.color} size="sm" /><span><strong>{holderName(state, holder)}</strong><Code>{key}</Code></span><Button icon="unlock" tone="danger" onClick={() => run(() => collab({ action: 'lock', kind: 'force-release', key }))}>Release</Button></div>) : <p className="hint">Nobody is holding a lock.</p>}</Panel>}
    {cap.admin && <Panel title="Room settings" icon="settings"><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); mutate('', { name: d.get('name'), visibility: d.get('visibility') }, 'PATCH'); }}><div className="form-row"><Field label="Name" className="grow"><input name="name" defaultValue={detail?.room.name} key={detail?.room.name} required /></Field><Field label="Visibility"><select name="visibility" defaultValue={detail?.room.visibility} key={detail?.room.visibility}><option value="private">Private</option><option value="listed">Listed</option></select></Field></div><div className="form-actions"><Button type="submit" icon="save">Save room settings</Button></div></form></Panel>}
    <Panel title="Danger zone" icon="warning" tone="danger"><div className="form-actions">
      {!cap.owner && <Button tone="danger" icon="logout" onClick={() => void ask('Leave this room?', 'Your membership is removed. You need a new invitation to come back.', 'Leave room', () => run(async () => { await request('POST', base + '/leave', {}); await collab({ action: 'leave' }); }))}>Leave membership</Button>}
      {cap.owner && <Button tone="danger" icon="trash" onClick={() => void ask('Delete this room?', 'The room, its project and its full revision history are deleted for everyone.', 'Delete room', () => run(async () => { await request('DELETE', base); await collab({ action: 'leave' }); }))}>Delete room</Button>}
    </div></Panel>
  </section>;
}
