import React, { useEffect, useState } from 'react';
import type { CollabState } from '../../../shared/collab/client.js';
import { request } from './api.js';
export function ServerAdmin({ state, run }: { state: CollabState; run: (fn: () => Promise<unknown>) => void }) {
  const [users, setUsers] = useState<any[]>([]); const [rooms, setRooms] = useState<any[]>([]); const [audit, setAudit] = useState<any[]>([]);
  async function refresh() { setUsers((await request('GET', '/api/admin/users')).users); setRooms((await request('GET', '/api/admin/rooms')).rooms); setAudit((await request('GET', '/api/admin/audit')).entries); }
  useEffect(() => { run(refresh); }, []);
  const mutate = (route: string, body: unknown, method: 'POST'|'PATCH' = 'POST') => run(async () => { await request(method, route, body); await refresh(); });
  return <section className="workspace-card"><h2>Server administration</h2>
    {state.user?.serverRole === 'SERVER_OWNER' && <form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); mutate('/api/admin/settings', { registrationMode: d.get('registration'), roomCreationMode: d.get('creation') }, 'PATCH'); }}><label>Registration<select name="registration" defaultValue={state.server?.registrationMode}><option value="open">Open</option><option value="approval">Approval required</option><option value="closed">Administrator creates accounts</option></select></label><label>Room creation<select name="creation"><option value="all_users">All users</option><option value="admins_only">Server administrators</option></select></label><button>Save server policy</button></form>}
    <details><summary>Create an account</summary><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); mutate('/api/admin/users', { username: d.get('username'), displayName: d.get('displayName'), password: d.get('password') }); }}><label>Username<input name="username" required /></label><label>Display name<input name="displayName" required /></label><label>Initial password<input type="password" name="password" minLength={8} required /></label><button>Create user</button></form></details>
    {users.map(u => <div className="collab-row" key={u.id}><strong>{u.displayName}</strong><span>{u.username} · {u.status} · {u.serverRole}</span>{u.id !== state.user?.id && u.serverRole !== 'SERVER_OWNER' && <>
      {u.status === 'PENDING_APPROVAL' && <button onClick={() => mutate(`/api/admin/users/${u.id}/approve`, {})}>Approve</button>}
      <button onClick={() => mutate(`/api/admin/users/${u.id}`, { status: u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' }, 'PATCH')}>{u.status === 'DISABLED' ? 'Enable' : 'Disable'}</button>
      <details><summary>Reset password</summary><form onSubmit={e => { e.preventDefault(); const newPassword = new FormData(e.currentTarget).get('password'); mutate(`/api/admin/users/${u.id}/reset-password`, { newPassword }); }}><label>New password<input name="password" type="password" minLength={8} required /></label><button>Reset password</button></form></details>
      {state.user?.serverRole === 'SERVER_OWNER' && <button onClick={() => mutate(`/api/admin/users/${u.id}`, { serverRole: u.serverRole === 'USER' ? 'SERVER_ADMIN' : 'USER' }, 'PATCH')}>{u.serverRole === 'USER' ? 'Make administrator' : 'Remove administrator role'}</button>}</>}</div>)}
    <h3>Rooms</h3>{rooms.map(room => <div className="collab-row" key={room.id}>{room.name}<form onSubmit={e => { e.preventDefault(); const userId = new FormData(e.currentTarget).get('owner'); mutate(`/api/admin/rooms/${room.id}/resolve`, { userId, role: 'ROOM_OWNER' }); }}><label>New owner<select name="owner">{users.filter(u => u.status === 'ACTIVE').map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></label><button>Resolve ownership</button></form></div>)}
    <details><summary>Audit history</summary>{audit.map(a => <p key={a.id}>{a.createdAt} · {a.actorName} · {a.action}</p>)}</details>
  </section>;
}
