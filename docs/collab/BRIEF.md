# Multi-User Collaboration Brief (Product Owner Requirements)

This is the source of truth for turning the HLR Writing Tool from a single-user offline desktop app into a
**real-time, self-hosted, multi-user** requirements tool. `Agents.md` remains the spec for the existing
domain (hierarchy, IDs, persistence, settings). Where this brief conflicts with `Agents.md`, this brief wins.
Update `Agents.md` when the design is final so both stay consistent.

## 0. Original request (product owner, translated)

> One user creates a room. In the room they open or create a project. They invite other users, or users send
> join requests to rooms. Design all admin and permission concerns. Users receive creation/changes of
> modules, submodules, functions, requirement sets instantly. New or edited requirements arrive live. If an
> input field is being filled, it is highlighted in a color and the editor's name is shown. Users online in
> the room, and users viewing the same document, are visible. Save authority belongs to admins, but autosave
> exists. Fill the gaps and deliver a good multi-user requirements tool. The server is self-managed and is
> installed on an offline (air-gapped) computer. If there is no server, I can still work offline. I enter the
> server IP manually, but there is also automatic discovery: I see servers present on the network. Accounts
> are per server. Every change is propagated simultaneously to everyone in the room.

## 1. Hard constraints

1. **Air-gapped.** Server and client must install and run with zero internet. Every new dependency must be
   pure JS or vendorable through the existing `offline/` bundle flow. No CDNs, no cloud services, no telemetry.
2. **Offline-first is preserved.** With no server, the desktop app works exactly as today (local workspace).
3. **Existing data format stays human-readable JSON** (`Agents.md` section 6). The server stores projects in the
   same workspace format so a project can be exported/imported between local and server.
4. **ID immutability rules (`Agents.md` section 5) must hold under concurrency.** Two users must never get the same ID.
   ID allocation is server-authoritative in a room.
5. Keep the existing security posture of the renderer (context isolation, sandbox, validated IPC, CSP).
   Network access is allowed only to the user-chosen server, from the main process or a narrowly-scoped
   connection; update the CSP to allow only that.
6. TypeScript strict, tests for every new module (vitest), all existing tests keep passing.

## 2. Decisions already made (do not re-litigate, refine only)

| Topic | Decision |
|---|---|
| Server runtime | Node.js headless process in this repo (`src/server/`), started with `npm run server`, also shippable as a standalone offline bundle / systemd service / the existing Dockerfile. Shared domain code reused from `src/shared` and `src/main/services`. |
| Transport | WebSocket (`ws` package) over HTTP(S). REST (plain `node:http`, or a tiny router) for auth, rooms, admin. |
| Live sync | **Yjs CRDT** per project document (`yjs`, `y-protocols` for sync + awareness). Custom minimal websocket provider is fine. Server holds the authoritative Y.Doc per open project and persists it. |
| Presence | Yjs awareness: user id, display name, color, current view (function/module id), focused field (`itemId` + `columnId`), cursor in text. |
| Field highlight | When a user focuses a field, every other client shows that field with the user's color outline + name tag. Text fields (text/Markdown) merge character-level via `Y.Text`. Scalar fields (number/date/boolean/dropdown/reference) are last-writer-wins; show a soft lock (highlight + name, warn before overwriting). |
| ID allocation | Server-authoritative. Clients create pending rows with temporary ids; server assigns real IDs atomically and broadcasts. Retired IDs stay retired. |
| Discovery | UDP broadcast beacon on the LAN (no mDNS dependency needed): server announces `{name, version, host, port, tls, fingerprint}` every few seconds on a fixed port; client lists discovered servers. Manual `host:port` entry always available. |
| Security on LAN | HTTPS/WSS with a self-signed certificate generated on first server start; client pins the fingerprint on first connect (trust-on-first-use) and warns if it changes. Plain HTTP allowed only with an explicit server flag for testing. |
| Accounts | Per server. Passwords hashed with `node:crypto` scrypt. Session tokens (random, stored hashed, expiring). First account created through a one-time **setup token** printed to the server console becomes Server Owner. |
| Storage on server | Server data dir: SQLite (`better-sqlite3`) for users, sessions, rooms, memberships, invites, join requests, audit log; project workspaces as JSON on disk in the existing format; Yjs update log for crash safety. |
| Save model | **Autosave**: every change is persisted on the server continuously (debounced, crash-safe) to the room's working copy. Nobody loses work. **Save** (admins only) creates a named, immutable **revision** (snapshot of the JSON workspace) with message, author, timestamp. Admins can view revision history, diff, and restore (restore is itself a new revision). Clients show "autosaved" / "last revision" status. |

## 3. Roles and permissions (refine into `docs/collab/PERMISSIONS.md`)

Server level:
- **Server Owner**: everything, including server settings, promoting Server Admins, deleting any room.
- **Server Admin**: manage users (create, disable, reset password), see all rooms, resolve stuck rooms.
- **User**: create rooms (server setting can restrict room creation to admins), join rooms.
- Registration mode is a server setting: open, approval required, or admin-created accounts only.

Room level:
- **Room Owner** (creator): all room rights, transfer ownership, delete room.
- **Room Admin**: invite/remove members, approve/reject join requests, change roles below admin, **Save revision**,
  restore revisions, edit project settings (columns, prefixes, object enablement), delete modules/functions.
- **Editor**: create/edit/delete requirements and items, create modules/submodules/functions, edit scope Markdown.
- **Viewer**: read-only, sees presence, can export.

Room flows:
- Room visibility: **private** (invite only) or **listed** (visible to all server users, who can send a join request).
- Invites: direct invite to a server user (they accept/decline), and invite codes with expiry and max uses.
- Join requests: user requests, room admins get a live notification, approve with a chosen role or reject.
- Kick, ban, leave, role change, ownership transfer. All of these go to an audit log.
- Permission checks happen **on the server** for every REST call and every Yjs update (reject updates from
  viewers; reject settings changes from non-admins). The UI hides what the user cannot do, but the server enforces.

One room holds one active project. A user can open or create the project when creating the room, import a local
workspace into it, or export it back to a local workspace.

## 4. Client UX (fill the gaps sensibly)

- Start screen: **Work offline** (today's flow) or **Connect to server**: discovered servers list (name, address,
  online state) plus manual address entry, login/register, remembered servers.
- Room lobby: my rooms, listed rooms, pending invites, my join requests, create room.
- In room: member list with online state and avatar color, who is viewing which function (avatars on tree nodes
  and in the editor header), live tree updates, live table updates, field highlights with name tags,
  notifications (join requests, role changes, revision saved, user joined/left).
- Connection state indicator: connected / reconnecting / offline. On temporary disconnect the client keeps
  editing locally (Yjs + local persistence) and syncs on reconnect. Permission loss while offline is handled by
  server rejection on reconnect with a clear message.
- Conflicts on structural operations (e.g. editing inside a module another user deleted) must resolve
  deterministically and be explained to the user.

## 5. Quality bar

- Unit tests for permissions matrix, ID allocation under concurrency, protocol messages, discovery beacon parsing.
- An integration test that starts a real server on localhost with two simulated clients: both edit, presence and
  highlights propagate, IDs never collide, viewer writes are rejected, admin save creates a revision.
- `npm run typecheck` and `npm test` green at the end of every task.
- Update `README.md` with server install (offline), first-run setup token, client connection steps.
