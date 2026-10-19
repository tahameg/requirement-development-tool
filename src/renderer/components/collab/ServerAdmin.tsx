import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import { request } from './api.js';
import { Icon } from '../ui/Icon.js';
import { Badge, Button, ButtonGroup, Field, Panel } from '../ui/primitives.js';
export function ServerAdmin({ state, run }: { state: CollabState; run: (fn: () => Promise<unknown>) => void }) {
  const [users, setUsers] = useState<any[]>([]); const [rooms, setRooms] = useState<any[]>([]); const [audit, setAudit] = useState<any[]>([]);
  async function refresh() { setUsers((await request('GET', '/api/admin/users')).users); setRooms((await request('GET', '/api/admin/rooms')).rooms); setAudit((await request('GET', '/api/admin/audit')).entries); }
  useEffect(() => { run(refresh); }, []);
  const mutate = (route: string, body: unknown, method: 'POST'|'PATCH' = 'POST') => run(async () => { await request(method, route, body); await refresh(); });
  return <div className="admin">
    <div className="lobby-columns">
      {state.user?.serverRole === 'SERVER_OWNER' && <Panel title="Server policy" icon="shield"><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); mutate('/api/admin/settings', { registrationMode: d.get('registration'), roomCreationMode: d.get('creation') }, 'PATCH'); }}>
        <Field label="Registration"><select name="registration" defaultValue={state.server?.registrationMode}><option value="open">Open</option><option value="approval">Approval required</option><option value="closed">Administrators create accounts</option></select></Field>
        <Field label="Room creation"><select name="creation" defaultValue={state.server?.roomCreationMode}><option value="all_users">All users</option><option value="admins_only">Server administrators</option></select></Field>
        <div className="form-actions"><Button type="submit" icon="save">Save policy</Button></div></form></Panel>}
      <Panel title="Create an account" icon="plus"><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); mutate('/api/admin/users', { username: d.get('username'), displayName: d.get('displayName'), password: d.get('password') }); }}>
        <div className="form-row"><Field label="Username" className="grow"><input name="username" required /></Field><Field label="Display name" className="grow"><input name="displayName" required /></Field></div>
        <Field label="Initial password"><input type="password" name="password" minLength={8} required /></Field><div className="form-actions"><Button type="submit" icon="plus">Create user</Button></div></form></Panel>
    </div>
    <Panel title="Users" icon="users">{users.map(u => <div className="member-row" key={u.id}><Icon name={u.serverRole === 'SERVER_OWNER' ? 'crown' : u.serverRole === 'SERVER_ADMIN' ? 'shield' : 'user'} /><span className="member-name"><strong>{u.displayName}</strong><small>{u.username}</small></span>
      <Badge tone={u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'danger' : 'accent'}>{u.status.replaceAll('_', ' ').toLowerCase()}</Badge>
      {u.id !== state.user?.id && u.serverRole !== 'SERVER_OWNER' && <>
        {u.status === 'PENDING_APPROVAL' && <Button tone="primary" icon="check" onClick={() => mutate(`/api/admin/users/${u.id}/approve`, {})}>Approve</Button>}
        {state.user?.serverRole === 'SERVER_OWNER' && <Button icon="shield" onClick={() => mutate(`/api/admin/users/${u.id}`, { serverRole: u.serverRole === 'USER' ? 'SERVER_ADMIN' : 'USER' }, 'PATCH')}>{u.serverRole === 'USER' ? 'Make admin' : 'Remove admin'}</Button>}
        <details className="inline-details"><summary><Icon name="key" size={14} />Reset password</summary><form onSubmit={e => { e.preventDefault(); const newPassword = new FormData(e.currentTarget).get('password'); mutate(`/api/admin/users/${u.id}/reset-password`, { newPassword }); }}><input name="password" type="password" minLength={8} required aria-label="New password" /><Button type="submit">Reset</Button></form></details>
        <ButtonGroup label="Status"><Button tone={u.status === 'DISABLED' ? 'default' : 'danger'} icon={u.status === 'DISABLED' ? 'check' : 'ban'} onClick={() => mutate(`/api/admin/users/${u.id}`, { status: u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' }, 'PATCH')}>{u.status === 'DISABLED' ? 'Enable' : 'Disable'}</Button></ButtonGroup>
      </>}</div>)}</Panel>
    <Panel title="Rooms" icon="grid">{rooms.map(room => <div className="list-row" key={room.id}><Icon name="grid" /><span>{room.name}</span><form className="inline-form" onSubmit={e => { e.preventDefault(); const userId = new FormData(e.currentTarget).get('owner'); mutate(`/api/admin/rooms/${room.id}/resolve`, { userId, role: 'ROOM_OWNER' }); }}><select name="owner" aria-label="New owner">{users.filter(u => u.status === 'ACTIVE').map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select><Button type="submit" icon="crown">Set owner</Button></form></div>)}</Panel>
    <details className="panel audit"><summary className="panel-head"><h2><Icon name="history" />Audit history</h2></summary><div className="panel-body">{audit.map(a => <div className="audit-row" key={a.id}><small>{new Date(a.createdAt).toLocaleString()}</small><strong>{a.actorName}</strong><code className="id-code">{a.action}</code></div>)}</div></details>
  </div>;
}
