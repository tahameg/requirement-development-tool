# Multi-User Collaboration Permissions Specification

This document defines the role hierarchy, complete permission matrices (server-level and room-level), membership state transitions, and the exact enforcement points across the server and client.

> [!IMPORTANT]
> **Golden Rule**: Every permission check is enforced **authoritatively on the server** for both REST endpoints and WebSocket/Yjs binary updates. The client UI hides or disables disallowed controls for ergonomics, but the server never trusts the client.

---

## 1. Role Definitions

### 1.1 Server Roles (`ServerRole`)
Ordered from highest to lowest privilege:
1. `SERVER_OWNER` — Created via the one-time console setup token on first server boot. Has full control over server settings, admins, users, and all rooms.
2. `SERVER_ADMIN` — Appointed by `SERVER_OWNER`. Manages user accounts (create, approve, disable, reset password), views all rooms (including private rooms for administrative oversight), and resolves stuck rooms (force-delete or assign a Room Admin).
3. `USER` — Standard authenticated server account. Can create rooms (unless `roomCreationMode === 'admins_only'`), join rooms via invite or join request, and participate according to their room role.

### 1.2 Server Settings Affecting Permissions
- `registrationMode`:
  - `'open'` (default): Anyone can register via `POST /api/auth/register` and immediately receives an `ACTIVE` `USER` account.
  - `'approval'`: Self-registration creates a `PENDING_APPROVAL` account; a `SERVER_OWNER` or `SERVER_ADMIN` must approve the account before login/session use is permitted.
  - `'closed'`: Self-registration is rejected (`403 FORBIDDEN`); only `SERVER_OWNER` or `SERVER_ADMIN` can create accounts via `POST /api/admin/users`.
- `roomCreationMode`:
  - `'all_users'` (default): Any active user (`USER`, `SERVER_ADMIN`, `SERVER_OWNER`) can create rooms.
  - `'admins_only'`: Only `SERVER_OWNER` and `SERVER_ADMIN` can create rooms.

### 1.3 Room Roles (`RoomRole`)
Ordered from highest to lowest privilege within a room:
1. `ROOM_OWNER` — Exactly one per room (initially the room creator). Has all room privileges, can promote/demote `ROOM_ADMIN`s, transfer room ownership to another room member, and delete the room.
2. `ROOM_ADMIN` — Can invite users, generate/revoke invite codes, approve/reject join requests, change member roles below admin (`EDITOR` <-> `VIEWER`), kick/ban `EDITOR`s and `VIEWER`s, edit room metadata, **save named revisions**, **view revision history & diffs**, **restore revisions**, **edit project settings** (`project.config.json`: prefixes, casing, object enablement, custom columns), and **delete modules and functions**.
3. `EDITOR` — Can create and edit modules, submodules, and functions; edit module and function scope Markdown descriptions; create, edit, and delete requirements/items in any function; and export workspace/function data. **Cannot** delete modules/functions, edit project settings, or save/restore named revisions.
4. `VIEWER` — Read-only access to the room's workspace. Can view live updates, broadcast and view presence/awareness (which module/function they are viewing), run full-text search, and export workspace/function data (CSV, Markdown, or local JSON workspace export). **Cannot** modify any workspace data or focus/lock editable fields.

---

## 2. Server-Level Permission Matrix (`ServerRole` × Action)

| Action ID | Description | Unauthenticated | `USER` | `SERVER_ADMIN` | `SERVER_OWNER` | Enforcement Location |
|---|---|:---:|:---:|:---:|:---:|---|
| `auth:setup` | Claim initial `SERVER_OWNER` with one-time setup token (when 0 users exist) | Yes (with valid token) | No | No | No | `src/server/auth.ts` (`claimSetupToken`), `POST /api/auth/setup` |
| `auth:register` | Self-register account (`registrationMode` = `open` or `approval`) | Yes (if mode != `closed`) | — | — | — | `src/server/auth.ts` (`registerUser`), `POST /api/auth/register` |
| `auth:login` | Authenticate with username & password (`status === 'ACTIVE'`) | Yes | Yes | Yes | Yes | `src/server/auth.ts` (`loginUser`), `POST /api/auth/login` |
| `auth:logout` | Revoke current session token | No | Yes | Yes | Yes | `src/server/auth.ts` (`logoutSession`), `POST /api/auth/logout` |
| `server:view-settings` | View server name, registration mode, room creation mode | Yes (public info) | Yes | Yes | Yes | `src/server/httpServer.ts`, `GET /api/server/info` |
| `server:update-settings` | Change `serverName`, `registrationMode`, `roomCreationMode` | No | No | No | **Yes** | `src/shared/collab/permissions.ts` (`canServerAction`), `PATCH /api/admin/settings` |
| `users:list` | List all server users and their statuses/roles | No | No | **Yes** | **Yes** | `canServerAction`, `src/server/auth.ts`, `GET /api/admin/users` |
| `users:directory` | Search active usernames/displayNames to invite to a room | No | **Yes** | **Yes** | **Yes** | `GET /api/users/directory` |
| `users:create` | Administratively create an active user account | No | No | **Yes** (as `USER`) | **Yes** (as `USER` or `SERVER_ADMIN`) | `canServerAction`, `src/server/auth.ts`, `POST /api/admin/users` |
| `users:approve` | Approve a `PENDING_APPROVAL` user registration | No | No | **Yes** | **Yes** | `canServerAction`, `src/server/auth.ts`, `POST /api/admin/users/:id/approve` |
| `users:disable` | Disable/enable user account & revoke active sessions | No | No | **Yes** (`USER` targets only) | **Yes** (`USER` & `SERVER_ADMIN` targets) | `canServerAction`, `src/server/auth.ts`, `PATCH /api/admin/users/:id` |
| `users:reset-password` | Reset another user's password & clear their sessions | No | No | **Yes** (`USER` targets only) | **Yes** (`USER` & `SERVER_ADMIN` targets) | `canServerAction`, `src/server/auth.ts`, `POST /api/admin/users/:id/reset-password` |
| `users:change-server-role` | Promote `USER` to `SERVER_ADMIN` or demote `SERVER_ADMIN` to `USER` | No | No | No | **Yes** | `canServerAction`, `src/server/auth.ts`, `PATCH /api/admin/users/:id` |
| `rooms:create` | Create a new room (with new or imported workspace) | No | **Yes** (if `all_users`) | **Yes** | **Yes** | `canServerAction`, `src/server/rooms.ts`, `POST /api/rooms` |
| `rooms:list-all-admin` | View all rooms on the server (including private rooms) | No | No | **Yes** | **Yes** | `canServerAction`, `src/server/rooms.ts`, `GET /api/admin/rooms` |
| `rooms:resolve-stuck` | Force-promote a member to `ROOM_ADMIN`/`ROOM_OWNER` or unlock a room | No | No | **Yes** | **Yes** | `canServerAction`, `src/server/rooms.ts`, `POST /api/admin/rooms/:id/resolve` |
| `rooms:force-delete` | Delete any room on the server regardless of room membership | No | No | **Yes** | **Yes** | `canServerAction`, `src/server/rooms.ts`, `DELETE /api/rooms/:id` |
| `audit:view-server` | View server-wide audit log | No | No | **Yes** | **Yes** | `canServerAction`, `GET /api/admin/audit` |

---

## 3. Room-Level Permission Matrix (`RoomRole` × Action)

> [!NOTE]
> A user who is banned from a room (`room_bans`) is denied all room actions including `room:request-join` and `room:redeem-invite-code` until unbanned by a `ROOM_ADMIN` or `ROOM_OWNER`.

| Action ID | Description | Non-Member (`USER`) | `VIEWER` | `EDITOR` | `ROOM_ADMIN` | `ROOM_OWNER` | Enforcement Location |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| `room:view-listed` | See room summary in Lobby if `visibility === 'listed'` | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | `src/server/rooms.ts` (`listRoomsForUser`), `GET /api/rooms` |
| `room:request-join` | Send join request to a `listed` room (if not member/banned) | **Yes** | No | No | No | No | `src/server/rooms.ts` (`createJoinRequest`), `POST /api/rooms/:id/join-requests` |
| `room:accept-direct-invite` | Accept/decline a pending direct invite to this user | **Yes** (invitee) | — | — | — | — | `src/server/rooms.ts` (`respondToInvite`), `POST /api/invites/:inviteId/respond` |
| `room:redeem-invite-code` | Join room using a valid, non-expired, under-limit invite code | **Yes** (if not banned) | — | — | — | — | `src/server/rooms.ts` (`redeemInviteCode`), `POST /api/invites/redeem` |
| `room:connect-ws` | Open live WebSocket session to the room & receive `Y.Doc` sync | No | **Yes** | **Yes** | **Yes** | **Yes** | `src/server/wsHandler.ts` (WS auth handshake) |
| `room:broadcast-view-presence` | Publish awareness of current viewed module/function | No | **Yes** | **Yes** | **Yes** | **Yes** | `src/server/wsHandler.ts` (`handleAwarenessFrame`) |
| `room:broadcast-field-focus` | Publish awareness of focused/editing field (`focus` highlight/lock) | No | **No** (stripped) | **Yes** | **Yes** | **Yes** | `src/server/wsHandler.ts` (`handleAwarenessFrame` strips `focus` for `VIEWER`) |
| `room:export` | Export room workspace (CSV, Markdown, or full JSON workspace) | No | **Yes** | **Yes** | **Yes** | **Yes** | `canRoomAction`, `GET /api/rooms/:id/export` & client export |
| `room:leave` | Voluntarily leave the room | No | **Yes** | **Yes** | **Yes** | **No** (must transfer ownership or delete room first) | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/leave` |
| `item:create` | Create new requirement / item (`alloc-item` or pending row) | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`allocateItem` & `applyClientUpdate`) |
| `item:edit` | Edit item column values (`Y.Text` or scalar `Y.Map`) | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `item:delete` | Delete an item (and retire its permanent ID) | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:create-module` | Create module or submodule | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:edit-module` | Rename module, change module prefix, or edit module description | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:create-function` | Create leaf function group | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:edit-function` | Edit function name, prefix, or scope Markdown `description` | No | No | **Yes** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:delete-module` | Delete module and its subtree (retiring all contained item IDs) | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `hierarchy:delete-function` | Delete function (retiring all contained item IDs) | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `project:edit-settings` | Edit `project.config.json` (prefixes, casing, object enablement, columns) | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/roomRuntime.ts` (`validateYDocDiffPermissions`) |
| `revision:save` | Save a named, immutable revision snapshot | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/revisions.ts`, `POST /api/rooms/:id/revisions` |
| `revision:history-diff` | View full revision history list and compare revision diffs | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/revisions.ts`, `GET /api/rooms/:id/revisions` & `.../diff` |
| `revision:restore` | Restore a past revision (creating a new revision snapshot) | No | No | **No** | **Yes** | **Yes** | `canRoomAction`, `src/server/revisions.ts`, `POST /api/rooms/:id/revisions/:revId/restore` |
| `member:invite-user` | Send direct invite to a server user (for `EDITOR` or `VIEWER` role, or `ROOM_ADMIN` if Owner) | No | No | No | **Yes** (up to `EDITOR`) | **Yes** (up to `ROOM_ADMIN`) | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/invites` |
| `member:create-invite-code` | Create shareable invite code with expiry & `maxUses` (`EDITOR` or `VIEWER`) | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/invite-codes` |
| `member:revoke-invite` | Revoke pending direct invite or invite code | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `DELETE /api/rooms/:id/invites/:inviteId` |
| `member:review-join-request` | Approve (choosing `VIEWER` or `EDITOR` role) or reject a join request | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/join-requests/:reqId/review` |
| `member:change-role-below-admin` | Change a member's role between `VIEWER` and `EDITOR` | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `PATCH /api/rooms/:id/members/:userId` |
| `member:promote-demote-admin` | Promote member to `ROOM_ADMIN` or demote `ROOM_ADMIN` to `EDITOR`/`VIEWER` | No | No | No | **No** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `PATCH /api/rooms/:id/members/:userId` |
| `member:kick-ban` | Kick or ban/unban a room member (`ROOM_ADMIN` can only kick/ban `EDITOR`/`VIEWER`; `ROOM_OWNER` can kick/ban anyone except self) | No | No | No | **Yes** (target < `ROOM_ADMIN`) | **Yes** (target != `ROOM_OWNER`) | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/members/:userId/kick` & `.../ban` |
| `room:edit-metadata` | Change room name or visibility (`private` <-> `listed`) | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `PATCH /api/rooms/:id` |
| `room:view-audit` | View room audit log (joins, role changes, kicks, bans, revisions) | No | No | No | **Yes** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `GET /api/rooms/:id/audit` |
| `room:transfer-ownership` | Transfer `ROOM_OWNER` to another existing room member (former owner becomes `ROOM_ADMIN`) | No | No | No | **No** | **Yes** | `canRoomAction`, `src/server/rooms.ts`, `POST /api/rooms/:id/transfer-ownership` |
| `room:delete` | Permanently delete the room and its workspace/revisions | No | No | No | **No** | **Yes** (or `SERVER_OWNER` / `SERVER_ADMIN`) | `canRoomAction`, `src/server/rooms.ts`, `DELETE /api/rooms/:id` |

---

## 4. Enforcement Points & Defense-in-Depth

### 4.1 Shared Pure Policy Module (`src/shared/collab/permissions.ts`)
All permission rules are implemented as pure, deterministic functions tested in `tests/unit/collabPermissions.test.ts`:
- `canServerAction(actorRole: ServerRole, action: ServerAction, context?: { targetRole?: ServerRole; roomCreationMode?: RoomCreationMode }): boolean`
- `canRoomAction(actorRoomRole: RoomRole | null, action: RoomAction, context?: { targetRoomRole?: RoomRole; assignedRole?: RoomRole; actorServerRole?: ServerRole }): boolean`
- `validateYDocDiffPermissions(actorRoomRole: RoomRole, prevWorkspace: Workspace, nextWorkspace: Workspace): { ok: true } | { ok: false; code: 'FORBIDDEN' | 'CONFLICT'; message: string }`

### 4.2 REST API Layer (`src/server/httpServer.ts`, `src/server/auth.ts`, `src/server/rooms.ts`, `src/server/revisions.ts`)
- Every `/api/*` endpoint (except `/api/server/info`, `/api/auth/setup`, `/api/auth/register`, `/api/auth/login`) extracts the Bearer token via `AuthService.authenticateRequest(req)`.
- Disabled accounts (`status !== 'ACTIVE'`) and expired sessions are rejected with `401 UNAUTHORIZED`.
- Each service method calls `canServerAction` or `canRoomAction` against the database's current authoritative role before executing any mutation. Violations return `403 FORBIDDEN`.

### 4.3 WebSocket & Yjs Update Layer (`src/server/wsHandler.ts`, `src/server/roomRuntime.ts`)
- **Connection Handshake**: Verifies session token, checks that the user is an active member of `roomId` and not banned, and attaches `(userId, roomRole)` to the connection context.
- **Live Role/Membership Revocation**: When a member's role is changed (`PATCH /api/rooms/:id/members/:userId`) or the member is kicked/banned:
  - `RoomRuntime` immediately updates the live socket's `roomRole` in memory (or terminates the socket on kick/ban with `{ type: 'kicked' | 'banned' }`).
  - Therefore, a user demoted to `VIEWER` cannot send any further write frames on an already-open WebSocket!
- **Yjs Binary Update Verification (`RoomRuntime.applyClientUpdate`)**:
  1. If `socket.roomRole === 'VIEWER'`, the update is rejected immediately before touching `Y.Doc`.
  2. For `EDITOR`, `ROOM_ADMIN`, and `ROOM_OWNER`, `RoomRuntime` clones `room.ydoc` into a temporary `stagedDoc`, applies the binary update to `stagedDoc`, converts `stagedDoc` to `nextWorkspace`, and runs `validateYDocDiffPermissions(socket.roomRole, prevWorkspace, nextWorkspace)`:
     - Rejects if `socket.roomRole === 'EDITOR'` and `config` changed (`project:edit-settings` violation).
     - Rejects if `socket.roomRole === 'EDITOR'` and any module ID or function ID present in `prevWorkspace` was removed (`hierarchy:delete-module` / `hierarchy:delete-function` violation).
     - Rejects if `watermarkCounter` decreased or any `retiredIds` entry was removed.
     - Detects structural conflicts (e.g. an edit inside a module/function that was concurrently deleted) and resolves deterministically in favor of the deletion.
  3. On rejection, the server leaves `room.ydoc` untouched, sends `{ type: 'error', code: 'FORBIDDEN' | 'VALIDATION_ERROR', message }` to the sender, and sends a corrective `sync-step2` frame so the sender's local `Y.Doc` reverts to the server's authoritative state.

### 4.4 Client Renderer UI Layer (`src/renderer/`)
- `VIEWER`: "Add module", "Add submodule", "Add function", "Properties", "Delete", "Add requirement/item", inline cell editing, scope textarea editing, "Project settings", and "Save revision" buttons are disabled/hidden. Export and search remain enabled.
- `EDITOR`: "Delete" on modules/functions, "Project settings", "Save revision", and "Revisions history/restore" are disabled/hidden. Creating/editing modules and functions and adding/editing/deleting items are enabled.
- `ROOM_ADMIN`: Full workspace editing, module/function deletion, project settings, member invitations, join request review, and revision save/history/diff/restore are enabled. Ownership transfer and room deletion are hidden.
- `ROOM_OWNER`: All room controls enabled.
