# Multi-User Collaboration Protocol & Data Shapes

This document specifies the wire protocols, REST API endpoints, WebSocket message types, Yjs CRDT document layout, Awareness state schema, UDP discovery beacon format, and server SQLite schema.

---

## 1. General HTTP / REST Conventions

- **Default Port**: `8443` (HTTPS + WSS by default; plain HTTP + WS only when `--insecure-http` is passed).
- **Content-Type**: `application/json; charset=utf-8` for all request and response bodies.
- **Authentication**: `Authorization: Bearer <sessionToken>` header on all authenticated endpoints.
- **Standard Response Envelope**:
  - Success (`200 OK` or `201 Created`): `{ "ok": true, "value": <ResponsePayload> }`
  - Error (`400`, `401`, `403`, `404`, `409`, `500`):
    ```json
    {
      "ok": false,
      "code": "BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
      "error": "Human-readable error message"
    }
    ```

---

## 2. REST API Endpoints

### 2.1 Public & Authentication Endpoints

| Method & Path | Required Role | Request Body | Response `value` | Errors |
|---|---|---|---|---|
| `GET /api/server/info` | Public | — | `{ serverId, name, version, tls, fingerprint, setupRequired: boolean, registrationMode: 'open' \| 'approval' \| 'closed', roomCreationMode: 'all_users' \| 'admins_only' }` | — |
| `POST /api/auth/setup` | Public (only when `setupRequired === true`) | `{ setupToken: string, username: string, displayName: string, password: string }` | `{ user: UserProfile, token: string, expiresAt: string }` (role = `SERVER_OWNER`) | `400` invalid fields, `403` invalid/consumed setup token |
| `POST /api/auth/register` | Public (when `registrationMode !== 'closed'`) | `{ username: string, displayName: string, password: string }` | `{ status: 'ACTIVE', user: UserProfile, token: string, expiresAt: string }` OR `{ status: 'PENDING_APPROVAL', user: UserProfile }` | `400` validation, `403` registration closed, `409` username exists |
| `POST /api/auth/login` | Public | `{ username: string, password: string }` | `{ user: UserProfile, token: string, expiresAt: string }` | `401` invalid credentials, `403` account disabled or pending approval |
| `POST /api/auth/logout` | Any Authenticated | `{}` | `{ loggedOut: true }` | `401` |
| `GET /api/auth/me` | Any Authenticated | — | `{ user: UserProfile }` | `401` |
| `GET /api/users/directory` | Any Authenticated | Query `?q=<search>` | `{ users: Array<{ id, username, displayName }> }` (active users only) | `401` |

### 2.2 Server Administration Endpoints

| Method & Path | Required Role | Request Body | Response `value` | Errors |
|---|---|---|---|---|
| `PATCH /api/admin/settings` | `SERVER_OWNER` | `{ name?: string, registrationMode?: 'open' \| 'approval' \| 'closed', roomCreationMode?: 'all_users' \| 'admins_only' }` | `{ settings: ServerSettings }` | `401`, `403` |
| `GET /api/admin/users` | `SERVER_OWNER`, `SERVER_ADMIN` | — | `{ users: UserAdminRecord[] }` | `401`, `403` |
| `POST /api/admin/users` | `SERVER_OWNER`, `SERVER_ADMIN` | `{ username: string, displayName: string, password: string, serverRole?: 'USER' \| 'SERVER_ADMIN' }` (`SERVER_ADMIN` may only assign `'USER'`) | `{ user: UserAdminRecord }` | `400`, `403`, `409` |
| `POST /api/admin/users/:userId/approve` | `SERVER_OWNER`, `SERVER_ADMIN` | `{}` | `{ user: UserAdminRecord }` | `403`, `404` |
| `PATCH /api/admin/users/:userId` | `SERVER_OWNER`, `SERVER_ADMIN` | `{ status?: 'ACTIVE' \| 'DISABLED', serverRole?: 'USER' \| 'SERVER_ADMIN', displayName?: string }` (`SERVER_ADMIN` can only modify `USER` accounts and cannot change `serverRole`) | `{ user: UserAdminRecord }` | `400`, `403`, `404` |
| `POST /api/admin/users/:userId/reset-password` | `SERVER_OWNER`, `SERVER_ADMIN` | `{ newPassword: string }` | `{ reset: true }` (revokes target user's sessions) | `400`, `403`, `404` |
| `GET /api/admin/rooms` | `SERVER_OWNER`, `SERVER_ADMIN` | — | `{ rooms: RoomSummary[] }` (includes all `private` and `listed` rooms) | `401`, `403` |
| `POST /api/admin/rooms/:roomId/resolve` | `SERVER_OWNER`, `SERVER_ADMIN` | `{ userId: string, role: 'ROOM_ADMIN' \| 'ROOM_OWNER' }` | `{ room: RoomSummary }` | `403`, `404` |
| `GET /api/admin/audit` | `SERVER_OWNER`, `SERVER_ADMIN` | Query `?limit=100` | `{ entries: AuditEntry[] }` | `401`, `403` |

### 2.3 Room Lobby, Membership, Invites & Join Requests Endpoints

| Method & Path | Required Role | Request Body | Response `value` | Errors |
|---|---|---|---|---|
| `GET /api/rooms` | Any Authenticated | — | `{ myRooms: RoomSummary[], listedRooms: ListedRoomSummary[], myInvites: DirectInviteSummary[], myJoinRequests: JoinRequestSummary[] }` | `401` |
| `POST /api/rooms` | `USER` (if `all_users`), `SERVER_ADMIN`, `SERVER_OWNER` | `{ name: string, visibility: 'private' \| 'listed', projectName?: string, projectPrefix?: string, workspace?: Workspace }` | `{ room: RoomSummary }` (creator becomes `ROOM_OWNER`) | `400` invalid workspace, `403` restricted to admins |
| `GET /api/rooms/:roomId` | Room Member (or `SERVER_ADMIN`/`SERVER_OWNER`) | — | `{ room: RoomDetail, members: RoomMemberInfo[], invites: InviteInfo[], joinRequests: JoinRequestSummary[], bans: RoomBanInfo[], workspace: Workspace }` | `403`, `404` |
| `PATCH /api/rooms/:roomId` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ name?: string, visibility?: 'private' \| 'listed' }` | `{ room: RoomSummary }` | `400`, `403`, `404` |
| `DELETE /api/rooms/:roomId` | `ROOM_OWNER`, `SERVER_ADMIN`, `SERVER_OWNER` | — | `{ deleted: true }` | `403`, `404` |
| `POST /api/rooms/:roomId/leave` | `ROOM_ADMIN`, `EDITOR`, `VIEWER` | `{}` | `{ left: true }` (`ROOM_OWNER` receives `400` unless ownership transferred first) | `400`, `403`, `404` |
| `POST /api/rooms/:roomId/transfer-ownership` | `ROOM_OWNER` | `{ newOwnerUserId: string }` | `{ room: RoomSummary }` (caller becomes `ROOM_ADMIN`) | `400`, `403`, `404` |
| `POST /api/rooms/:roomId/invites` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ targetUserId: string, role: 'VIEWER' \| 'EDITOR' \| 'ROOM_ADMIN' }` (`ROOM_ADMIN` max `'EDITOR'`) | `{ invite: DirectInviteSummary }` | `400`, `403`, `404`, `409` |
| `POST /api/invites/:inviteId/respond` | Invited User | `{ accept: boolean }` | `{ accepted: boolean, roomId?: string, role?: RoomRole }` | `403` (or banned), `404` |
| `POST /api/rooms/:roomId/invite-codes` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ role: 'VIEWER' \| 'EDITOR', expiresInSeconds?: number, maxUses?: number }` | `{ inviteCode: InviteCodeInfo }` | `400`, `403` |
| `POST /api/invites/redeem` | Any Authenticated | `{ code: string }` | `{ room: RoomSummary, role: RoomRole }` | `400` expired/exhausted, `403` banned, `404` |
| `DELETE /api/rooms/:roomId/invites/:inviteId` | `ROOM_OWNER`, `ROOM_ADMIN` | — | `{ revoked: true }` | `403`, `404` |
| `POST /api/rooms/:roomId/join-requests` | Non-member `USER` (on `listed` room, not banned) | `{ message?: string }` | `{ joinRequest: JoinRequestSummary }` (pushes WS notification to online room admins) | `403` private/banned, `404`, `409` |
| `POST /api/rooms/:roomId/join-requests/:reqId/review` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ approve: boolean, role?: 'VIEWER' \| 'EDITOR' }` | `{ joinRequest: JoinRequestSummary }` | `400`, `403`, `404` |
| `PATCH /api/rooms/:roomId/members/:userId` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ role: 'VIEWER' \| 'EDITOR' \| 'ROOM_ADMIN' }` (`ROOM_ADMIN` can only change between `'VIEWER'` and `'EDITOR'`) | `{ member: RoomMemberInfo }` | `400`, `403`, `404` |
| `POST /api/rooms/:roomId/members/:userId/kick` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ reason?: string }` | `{ kicked: true }` | `403`, `404` |
| `POST /api/rooms/:roomId/members/:userId/ban` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ reason?: string }` | `{ banned: true }` | `403`, `404` |
| `DELETE /api/rooms/:roomId/bans/:userId` | `ROOM_OWNER`, `ROOM_ADMIN` | — | `{ unbanned: true }` | `403`, `404` |
| `GET /api/rooms/:roomId/audit` | `ROOM_OWNER`, `ROOM_ADMIN` | — | `{ entries: AuditEntry[] }` | `403`, `404` |
| `GET /api/rooms/:roomId/export` | `ROOM_OWNER`, `ROOM_ADMIN`, `EDITOR`, `VIEWER` | Query `?format=json\|csv\|markdown&objectType=...&functionId=...` | `{ format, content: string \| Workspace }` | `400`, `403`, `404` |

### 2.4 Revisions Endpoints

| Method & Path | Required Role | Request Body | Response `value` | Errors |
|---|---|---|---|---|
| `GET /api/rooms/:roomId/revisions` | `ROOM_OWNER`, `ROOM_ADMIN` | — | `{ revisions: RevisionMetadata[] }` | `403`, `404` |
| `POST /api/rooms/:roomId/revisions` | `ROOM_OWNER`, `ROOM_ADMIN` | `{ message: string }` | `{ revision: RevisionMetadata }` | `400`, `403`, `404` |
| `GET /api/rooms/:roomId/revisions/:revId` | `ROOM_OWNER`, `ROOM_ADMIN` | — | `{ revision: RevisionMetadata, workspace: Workspace }` | `403`, `404` |
| `GET /api/rooms/:roomId/revisions/:revId/diff` | `ROOM_OWNER`, `ROOM_ADMIN` | Query `?compareTo=<otherRevId\|current>` | `{ diff: RevisionDiff }` | `403`, `404` |
| `POST /api/rooms/:roomId/revisions/:revId/restore` | `ROOM_OWNER`, `ROOM_ADMIN` | `{}` | `{ revision: RevisionMetadata, workspace: Workspace }` (creates a new revision and broadcasts to room) | `403`, `404` |

---

## 3. WebSocket Protocol (`/ws/rooms/:roomId`)

### 3.1 Connection & Authentication
- Endpoint: `wss://<host>:<port>/ws/rooms/<roomId>?token=<sessionToken>` (or `Authorization: Bearer <sessionToken>` header).
- If the token is invalid, the user is not a member of `<roomId>`, or the user is banned, the server closes the WebSocket with code `4401` (`Unauthorized`) or `4403` (`Forbidden`).
- All WebSocket messages are UTF-8 JSON frames validated with Zod (`wsClientMessageSchema` and `wsServerMessageSchema`). Yjs is not used; synchronization is based on server-ordered operations, monotonic sequence numbers (`seq`), explicit lease locks, and presence broadcasts as specified in `ARCHITECTURE-v2.md`.

### 3.2 Client -> Server Messages (`WsClientMessage`)

```ts
export type WsClientMessage =
  // 1. Authoritative Operation Submission
  | {
      type: 'op';
      clientOpId: string;
      op: CollabOp;
    }
  // 2. Catch-up Request
  | {
      type: 'ops-since';
      sinceSeq: number;
    }
  // 3. Lease Lock Management
  | {
      type: 'lock-acquire';
      target: string; // e.g. "item:<id>" | "function:<id>:scope"
    }
  | {
      type: 'lock-release';
      target: string;
    }
  | {
      type: 'lock-heartbeat';
      targets: string[];
    }
  | {
      type: 'lock-force-release';
      target: string;
    }
  // 4. Ephemeral Presence
  | {
      type: 'presence-update';
      presence: PresenceState | null; // null on clear/blur
    }
  // 5. Keepalive Ping
  | {
      type: 'ping';
      timestamp: number;
    };
```

### 3.3 Server -> Client Messages (`WsServerMessage`)

```ts
export type WsServerMessage =
  // 1. Initial Room Handshake & Authoritative State
  | {
      type: 'room-welcome';
      roomId: string;
      role: RoomRole;
      workspace: Workspace;
      seq: number;
      locks: LockState;
      presence: PresenceBroadcastEntry[];
      members: OnlineMemberInfo[];
      autosaveStatus: { status: 'autosaved' | 'saving'; lastAutosavedAt: string | null };
      lastRevision: RevisionMetadata | null;
    }
  // 2. Operation Acknowledgment, Rejection & Broadcast
  | {
      type: 'op-ack';
      clientOpId: string;
      seq: number;
      opId: string;
      allocatedId?: string;
    }
  | {
      type: 'op-rejected';
      clientOpId: string;
      code: OpRejectCode;
      reason: string;
    }
  | {
      type: 'op-applied';
      seq: number;
      opId: string;
      actorId: string;
      op: CollabOp;
    }
  // 3. Catch-up & Snapshots
  | {
      type: 'ops-since-reply';
      ops: Array<{ seq: number; opId: string; actorId: string; op: CollabOp }>;
      latestSeq: number;
    }
  | {
      type: 'snapshot';
      workspace: Workspace;
      seq: number;
      locks: LockState;
    }
  // 4. Lock Events
  | {
      type: 'locks-changed';
      locks: LockState;
    }
  | {
      type: 'lock-granted';
      target: string;
      expiresAt: string;
    }
  | {
      type: 'lock-denied';
      target: string;
      heldBy: LockHolder;
    }
  | {
      type: 'lock-revoked';
      target: string;
      reason: 'expired' | 'force_released' | 'target_deleted';
    }
  // 5. Presence & Online Members
  | {
      type: 'presence-broadcast';
      entries: PresenceBroadcastEntry[];
      onlineMembers: OnlineMemberInfo[];
    }
  // 6. Autosave & Revision Events
  | {
      type: 'autosave-status';
      status: 'saving' | 'autosaved';
      lastAutosavedAt: string;
    }
  | {
      type: 'revision-saved';
      revision: RevisionMetadata;
      restoredFromId?: string;
    }
  // 7. Room Membership, Role & Admin Events
  | {
      type: 'room-notification';
      kind:
        | 'user-joined'
        | 'user-left'
        | 'role-changed'
        | 'join-request-created'
        | 'join-request-reviewed'
        | 'member-kicked'
        | 'member-banned'
        | 'ownership-transferred';
      message: string;
      targetUserId?: string;
      newRole?: RoomRole;
      joinRequest?: JoinRequestSummary;
      timestamp: string;
    }
  // 8. Conflicts, Errors & Lifecycle
  | {
      type: 'conflict';
      code: 'TARGET_DELETED' | 'CONCURRENT_STRUCTURE_CHANGE';
      targetId: string;
      message: string;
      snapshot?: Workspace;
      seq?: number;
    }
  | {
      type: 'error';
      code: 'FORBIDDEN' | 'PERMISSION_REVOKED' | 'VALIDATION_ERROR' | 'BAD_REQUEST';
      message: string;
      requestId?: string;
    }
  | {
      type: 'kicked' | 'banned' | 'room-deleted';
      reason: string;
    }
  | {
      type: 'pong';
      timestamp: number;
    };
```


---

## 4. Operation Model & Lease Locks (v2)

> [!WARNING]
> **Superseded by ARCHITECTURE-v2.md (Server-ordered ops + lease locks, no Yjs)**.
> Yjs document types (`Y.Doc`, `Y.Map`, `Y.Array`, `Y.Text`) and binary updates have been completely removed.
> The authoritative collaboration model uses server-ordered granular operations, atomic sequence numbers (`seq`), explicit lease locks (`LockState`), and standard JSON `Workspace` snapshots.

### 4.1 Granular Operations (`CollabOp`)
The server executes mutations sequentially in a single-threaded queue. The supported operations are:
- `item.create`: Append or insert a new item into a function.
- `item.edit`: Update column values of an existing item. Requires an active lease lock on `item:<id>`.
- `item.delete`: Delete an item and record its ID in `retiredIds`. Automatically releases any held lock.
- `item.reorder`: Change item order within a function.
- `function.create`: Create a function in a module.
- `function.edit`: Rename, update prefix, or change function properties.
- `function.editScope`: Update Markdown scope description. Requires an active lease lock on `function:<id>:scope`.
- `function.delete`: Delete a function and its items (retiring all item IDs). Requires that no other user holds locks inside the function.
- `function.reorder`: Change function display ordering.
- `module.create`: Create a module or submodule.
- `module.edit`: Rename or update prefix/description of a module.
- `module.delete`: Delete a module and its entire subtree. Requires that no other user holds locks inside the subtree.
- `module.reorder`: Change module display ordering.
- `config.update`: Update project configuration (`project.config.json`). Allowed for `ROOM_ADMIN` and `ROOM_OWNER` only; immutable fields (`projectId`, `version`) are rejected.

### 4.2 Lease Locks (`LockState`)
- **Granularity**: `item:<id>` (editing row values) and `function:<id>:scope` (editing function Markdown scope).
- **Lease duration**: 10 seconds.
- **Renewal**: Automatic heartbeat every 3 seconds while editing.
- **Grace period**: 30 seconds upon socket disconnect for seamless page reload / reconnect.
- **Hierarchy deletion guard**: Deleting a module or function checks the entire subtree; if any item or function inside holds an active lock by another user, the deletion is rejected with `SUBTREE_LOCKED`.

---

## 5. Presence State Shape (`PresenceState` & `PresenceBroadcastEntry`)

Presence is ephemeral, unlogged, and throttled (max 10 updates/sec per client):

```ts
export const COLLAB_USER_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#84cc16', // Lime
] as const;

export interface PresenceState {
  cursor?: { x: number; y: number } | null;
  selection?: {
    field?: string;
    range?: { start: number; end: number };
  } | null;
  objectType?: ObjectType | null;
  targetKind?: 'module' | 'function' | 'item' | null;
  targetId?: string | null;
  updatedAt: number; // Epoch ms
}

export interface PresenceBroadcastEntry {
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  color: string;
  presence: PresenceState | null;
}
```

---

## 6. UDP LAN Discovery Beacon Format & Ports

- **Transport**: IPv4 UDP datagrams (`node:dgram`, `socket.setBroadcast(true)`).
- **Default Port**: `41234` (configurable on server and client; `0` or custom port supported in tests).
- **Broadcast Targets**: `255.255.255.255` (LAN broadcast) and `127.0.0.1` (loopback so single-machine multi-process discovery works even without a LAN interface).
- **Announce Interval**: Every `3000` ms (`3` seconds).
- **Client Expiry Threshold**: A discovered server entry is marked `online: true` when seen within the last `10000` ms (`10` seconds) and `online: false` (stale) after `10` seconds without a beacon.
- **Beacon Wire Format (UTF-8 JSON <= 512 bytes)**:
  ```json
  {
    "magic": "HLR_SERVER_BEACON_V1",
    "serverId": "srv_91a8c0e2-3f11-4b88-9214-0192837465ab",
    "name": "Avionics HLR Server",
    "version": "0.6.0",
    "host": "192.168.1.50",
    "port": 8443,
    "tls": true,
    "fingerprint": "SHA256:4F:8A:12:...",
    "timestamp": 1760573748000
  }
  ```

---

## 7. Server SQLite Database Schema (`server.sqlite`)

Stored at `<dataDir>/server.sqlite` with `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`:

```sql
CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL DEFAULT 'HLR Collaboration Server',
  registration_mode TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'approval' | 'closed'
  room_creation_mode TEXT NOT NULL DEFAULT 'all_users', -- 'all_users' | 'admins_only'
  setup_token_hash TEXT,                                -- NULL once SERVER_OWNER is created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                                  -- usr_<uuid>
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,                          -- scrypt$<saltHex>$<hashHex>
  server_role TEXT NOT NULL DEFAULT 'USER',             -- 'SERVER_OWNER' | 'SERVER_ADMIN' | 'USER'
  status TEXT NOT NULL DEFAULT 'ACTIVE',                -- 'ACTIVE' | 'PENDING_APPROVAL' | 'DISABLED'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                          -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,                                  -- room_<uuid>
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',           -- 'private' | 'listed'
  owner_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  materialized_seq INTEGER NOT NULL DEFAULT 0,
  last_autosaved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                   -- 'ROOM_OWNER' | 'ROOM_ADMIN' | 'EDITOR' | 'VIEWER'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_bans (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  banned_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,                                  -- inv_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                   -- 'direct' | 'code'
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code TEXT UNIQUE,                                     -- For kind = 'code'
  role TEXT NOT NULL,                                   -- 'ROOM_ADMIN' | 'EDITOR' | 'VIEWER'
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING',               -- 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED'
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,                                  -- jreq_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',               -- 'PENDING' | 'APPROVED' | 'REJECTED'
  assigned_role TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,                                  -- rev_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  snapshot_filename TEXT NOT NULL,
  restored_from_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS room_ops (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  op_kind TEXT NOT NULL,
  op_payload TEXT NOT NULL,                             -- JSON-encoded CollabOp
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, op_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,                                  -- aud_<uuid>
  room_id TEXT,                                         -- NULL for server-level events
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```
