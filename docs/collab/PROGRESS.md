# Multi-User Collaboration Implementation Progress

## T01 Install collaboration dependencies and define shared types, permissions, and protocol schemas

### What Changed
- Installed pure-JavaScript collaboration dependencies (`yjs@13.6.33`, `y-protocols@1.0.7`, `lib0@0.2.119`, `ws@8.22.0`) and `@types/ws@8.18.2` into `package.json`, `package-lock.json`, and `offline/cache/npm` using `--ignore-scripts --save-exact` so existing Electron and `better-sqlite3` native binaries remain untouched.
- Created `src/shared/collab/types.ts` defining server/room roles, action literals (`SERVER_ACTIONS`, `ROOM_ACTIONS`), entity records (`ServerSettings`, `ServerPublicInfo`, `UserProfile`, `RoomSummary`, `ListedRoomSummary`, `RoomMemberInfo`, `RoomBanInfo`, `DirectInviteSummary`, `InviteCodeInfo`, `JoinRequestSummary`, `RevisionMetadata`, `RevisionDiff`, `AuditEntry`), awareness types (`AwarenessUserState`), WebSocket message unions (`WsClientMessage`, `WsServerMessage`), discovery beacon types (`DiscoveryBeacon`, `DiscoveredServer`), and deterministic user color assignment (`assignUserColor`).
- Created `src/shared/collab/permissions.ts` implementing `hasMinimumServerRole`, `hasMinimumRoomRole`, `canServerAction`, `canRoomAction`, and `validateYDocDiffPermissions`.
- Created `src/shared/collab/protocol.ts` implementing strict Zod schemas for all REST request/response envelopes and payloads, WebSocket client/server frames, Awareness states, and UDP LAN discovery beacons.
- Added unit test suites `tests/unit/collabPermissions.test.ts` and `tests/unit/collabProtocol.test.ts` achieving 100% statement/branch/function/line coverage across `src/shared/collab/*`.

### Decisions Made & Notes for Next Agent
- `canServerAction` accepts `actorRole: ServerRole | null` (`null` representing unauthenticated callers for `auth:setup`, `auth:register`, `auth:login`, `server:view-settings`) and optional `ServerPermissionContext`.
- `canRoomAction` accepts `actorRoomRole: RoomRole | null` (`null` representing non-members) and optional `RoomPermissionContext` (including `isBanned`, `visibility`, `assignedRole`, `targetRoomRole`, `actorServerRole`).
- `validateYDocDiffPermissions` returns `{ ok: true }` or `{ ok: false, code: 'FORBIDDEN' | 'CONFLICT', targetId?, message }` and detects both unauthorized mutations (`VIEWER` writes, `EDITOR` config edits or module/function deletions, decreased `watermarkCounter`, removed `retiredIds`, modified `projectId`) and structural conflicts (`CONFLICT` when a function or submodule references a concurrently deleted parent module).

## T02 Implement Yjs document conversion and character-level text diff helpers

### What Changed
- Created `src/shared/collab/yjsDoc.ts` implementing the deterministic bidirectional mapping between `Workspace` and `Y.Doc` (`workspaceToYDoc`, `yDocToWorkspace`, `syncWorkspaceToYDoc`, `cloneYDoc`) matching `docs/collab/PROTOCOL.md` §4.
- Implemented UTF-16 surrogate-pair-safe minimal character diffing (`computeTextDiff`, `applyTextChange`) for `Y.Text` fields (`description` on modules and functions, plus `string`, `text`, and `markdown` item columns).
- Implemented granular `Y.Doc` mutation and inspection helpers for `ProjectConfig` (`updateYDocConfig`), `retiredIds` (`addYDocRetiredIds`), modules (`upsertYDocModule`, `updateYDocModuleDescription`, `deleteYDocModule`, `getYDocModuleDescriptionText`), functions (`upsertYDocFunction`, `updateYDocFunctionDescription`, `setYDocWatermark`, `deleteYDocFunction`, `getYDocFunctionDescriptionText`), items (`upsertYDocItem`, `updateYDocItemField`, `deleteYDocItem`, `getYDocItemFieldText`), and temporary pending items (`addYDocPendingItem`, `resolveYDocPendingItem`, `getPendingItemsInYDoc`, `isPendingItemId`).
- Added unit test suite `tests/unit/yjsDoc.test.ts` verifying lossless round-trips across all 4 object types, concurrent `Y.Text` character-level merges between synced `Y.Doc`s, last-writer-wins on all scalar column types (`enum`, `number`, `boolean`, `date`, `reference`), monotonic `watermarkCounter` and `retiredIds` preservation, pending item resolution, and conflict detection compatibility with `validateYDocDiffPermissions`.

### Decisions Made & Notes for Next Agent
- `yDocToWorkspace(doc, options?)` excludes temporary `__pending__:<uuid>` items by default (`includePending: false`) so that the returned `Workspace` always satisfies `validateWorkspace`; pass `{ includePending: true }` or call `getPendingItemsInYDoc(doc)` when inspecting or resolving pending items in `RoomRuntime` / `CollabClient`.
- When reconstructing `fn.modulePath` in `yDocToWorkspace`, if `moduleChain` throws (for example, inside a conflicted staging `Y.Doc` where an administrator concurrently deleted a parent module), `modulePath` falls back to `[]` while preserving `fn.parentModuleId` so `validateYDocDiffPermissions` can return `{ ok: false, code: 'CONFLICT', targetId }` instead of throwing before permission/conflict inspection.
- `syncWorkspaceToYDoc(doc, nextWorkspace)` diffs and updates an existing `Y.Doc` in-place inside a single `doc.transact()`, preserving existing `Y.Text` instances so domain service outputs (`addItem`, `deleteItem`, `changeHierarchy`, `editFunction`, `updateProjectConfig`) can be applied to a live room `Y.Doc` without resetting CRDT text history.

## T03 Implement server SQLite storage, self-signed TLS generator, and authentication service

### What Changed
- Created `src/server/db.ts` implementing `ServerDatabase` (`server.sqlite` with WAL mode, foreign keys, and all 10 collaboration tables and indexes from `docs/collab/PROTOCOL.md` §7), typed row models (`ServerSettingsRow`, `UserRow`, `SessionRow`, `RoomRow`, `RoomMemberRow`, `RoomBanRow`, `InviteRow`, `JoinRequestRow`, `RevisionRow`, `YjsUpdateRow`, `AuditLogRow`), `CollabServiceError` (mapping `ApiErrorCode` to HTTP status codes), and audit log helpers (`appendAuditLog`, `listAuditLog`).
- Created `src/server/tls.ts` implementing pure-TypeScript ASN.1 DER X.509 v3 self-signed certificate generation (`generateSelfSignedCertificate`), disk persistence and reuse in `<dataDir>/tls/` (`ensureServerTlsCertificate`), and `SHA256:<hex-colon-separated>` fingerprint calculation and comparison (`computeCertFingerprint`, `normalizeFingerprint`, `fingerprintsMatch`) using only `node:crypto` with zero external `openssl` dependencies.
- Created `src/server/auth.ts` implementing `AuthService` (`claimSetupToken`, `registerUser`, `loginUser`, `logoutSession`, `authenticateToken`, `authenticateAuthorizationHeader`, `getServerSettings`, `getPublicInfo`, `updateServerSettings`, `searchUserDirectory`, `listUsers`, `createUser`, `approveUser`, `disableUser`, `enableUser`, `changeServerRole`, `updateUser`, `resetPassword`, `revokeUserSessions`, `listServerAuditLog`) plus `scrypt` password hashing (`hashPassword`, `verifyPassword`) and `sha256` token hashing (`hashToken`).
- Added unit test suite `tests/unit/serverAuth.test.ts` verifying X.509 certificate generation and `X509Certificate.verify`, SHA-256 fingerprint parsing, one-time `SERVER_OWNER` setup token consumption and reuse rejection, `open`/`approval`/`closed` registration modes, login/logout and session expiration, and `SERVER_OWNER`/`SERVER_ADMIN`/`USER` permission enforcement on user management actions.

### Decisions Made & Notes for Next Agent
- `ServerDatabase.open(dataDirOrDbPath, options?)` accepts `:memory:`, a `.sqlite`/`.db` file path, or a server `dataDir` directory path (storing `<dataDir>/server.sqlite` and exposing `serverDb.dataDir` for room workspaces and revisions).
- `CollabServiceError` (`code: ApiErrorCode`, `status: number`, `message: string`) is exported from `src/server/db.ts` (and re-exported from `src/server/auth.ts`); `RoomService` (T04), `RoomRuntime` / `CollabServer` (T05), and `RevisionService` (T11) should throw `CollabServiceError` so the HTTP router can map errors directly to `{ ok: false, code, error }` with `err.status`.
- `AuthService` accepts `{ sessionTtlMs?, initialSetupToken?, now? }` for deterministic clock/token testing and exposes `getInitialSetupToken()` so the server CLI (`src/server/index.ts`) can print the one-time setup token on first boot when `isSetupRequired()` is `true`.

## T04 Implement rooms, memberships, invites, join requests, and audit logging service

### What Changed
- Created `src/server/rooms.ts` implementing `RoomService`:
  - Room creation (`createRoom`) supporting fresh project initialization via `createWorkspace` and imported `Workspace` validation via `validateWorkspace`, persisted on disk under `<dataDir>/rooms/<roomId>/workspace/` via `saveWorkspace`.
  - Room lobby & detail queries (`listRoomsForUser`, `getRoom`, `getRoomSummary`, `listRoomMembers`, `listRoomInvites`, `listRoomJoinRequests`, `listRoomBans`), metadata editing (`updateRoom`), deletion (`deleteRoom`), leaving (`leaveRoom`), and ownership transfer (`transferOwnership`).
  - Direct user invitations (`createDirectInvite`, `respondToInvite`) and shareable invite codes (`createInviteCode`, `redeemInviteCode`, `revokeInvite`) enforcing role limits, expiration timestamps (`expiresAt`), and maximum redemption counts (`maxUses`).
  - Join requests on `listed` rooms (`createJoinRequest`, `reviewJoinRequest` with approval role assignment or rejection).
  - Member role changes (`changeMemberRole` enforcing `ROOM_ADMIN` vs `ROOM_OWNER` rules), kicking (`kickMember`), banning/unbanning (`banMember`, `unbanMember`), room workspace export (`exportRoom` for `json`, `csv`, and `markdown`), room audit log retrieval (`listRoomAuditLog`), and server-admin room oversight (`listAllRoomsAdmin`, `resolveStuckRoom`).
- Added unit test suite `tests/unit/serverRooms.test.ts` verifying all room lifecycle flows, permissions, invite/join-request workflows, bans, ownership transfers, and audit log entries.

### Decisions Made & Notes for Next Agent
- `RoomService.setRuntimeHooks({ getOnlineUserIds, getWorkspaceProvider, onRoomEvent })` allows `RoomRuntime` / `wsHandler` / `CollabServer` (T05) to wire live online member counts, live in-memory `Y.Doc` workspace snapshots for `getRoom` and `exportRoom`, and real-time WebSocket notifications for room membership/role/join-request events (`RoomLifecycleEvent`).
- `RoomService.getRoomDir(roomId)`, `getRoomWorkspaceDir(roomId)`, `getRoomRevisionsDir(roomId)`, `loadRoomWorkspace(roomId)`, `saveRoomWorkspace(roomId, workspace)`, and `recordAutosave(roomId, autosavedAt?)` are exposed for `RoomRuntime` (T05) and `RevisionService` (T11).
## T05 Implement room runtime, Yjs WebSocket sync, server-authoritative ID allocation, and HTTP/WS server

### What Changed
- Created `src/server/roomRuntime.ts` implementing `RoomRuntime` and `RoomRuntimeManager`:
  - Initializes and recovers room `Y.Doc` state from the room's on-disk working copy (`<dataDir>/rooms/<roomId>/workspace/`) plus any uncompacted `yjs_updates` rows in `server.sqlite`.
  - Handles WebSocket Yjs synchronization (`sync-step1`, `sync-step2`, `sync-update`) and `Awareness` broadcasts (`awareness-update`, automatically stripping field `focus` from `VIEWER` connections).
  - Enforces server-side permission and schema validation on every incoming Yjs update using a staged `Y.Doc` (`validateYDocDiffPermissions`, deleted-ancestor structural conflict detection, and `validateWorkspace`), rejecting unauthorized or invalid updates with `{ type: 'error', code, message }` followed by a corrective `sync-step2` containing the authoritative `Y.encodeStateAsUpdate(this.ydoc)`.
  - Implements atomic server-authoritative item allocation (`alloc-item` and automatic resolution of `__pending__:<uuid>` entries via `addItem` and `syncWorkspaceToYDoc`) so concurrent item creations across clients never collide and retired IDs remain retired.
  - Persists accepted Yjs updates immediately into `yjs_updates` (SQLite WAL) and schedules debounced crash-safe autosaves (`saveWorkspace` + `WorkspaceIndex.rebuild` + `yjs_updates` compaction into a single full-state update row) with `saved` notifications broadcast to connected room clients.
  - Wires `RoomService.setRuntimeHooks` for live online member counts, live in-memory `Workspace` snapshots (`getRoom` / `exportRoom`), and real-time room lifecycle notifications (`role-changed`, `kicked`, `join-request`, `room-deleted`).
- Created `src/server/wsHandler.ts` implementing `CollabWsHandler` (`createCollabWsHandler`) for `/ws/rooms/:roomId` upgrades, authenticating session tokens from `?token=<sessionToken>` or `Authorization: Bearer`, enforcing room membership/ban checks (`4401`, `4403`, `4404` close codes), buffering pre-ready client frames, and validating messages with `wsClientMessageSchema`.
- Created `src/server/httpServer.ts` implementing `CollabServer` (supporting both HTTPS/WSS with `ensureServerTlsCertificate` and plain HTTP/WS via `insecureHttp: true`) and all REST API endpoints specified in `docs/collab/PROTOCOL.md` §2.1–2.3 (`/api/health`, `/api/server/public`, `/api/auth/*`, `/api/users/search`, `/api/admin/*`, `/api/rooms/*`, and `/api/invites/*`).
- Created `src/server/index.ts` and `scripts/run-server.mjs` (`npm run server` in `package.json`) providing CLI flag parsing (`--data-dir`, `--host`, `--port`, `--discovery-port`, `--no-discovery`, `--insecure-http`, `--cert`, `--key`) and first-boot `SERVER_OWNER` setup token console banner output.
- Added `resetYDocToServerState` in `src/shared/collab/yjsDoc.ts` so clients can cleanly reset a local `Y.Doc` in-place to an authoritative server snapshot when local unaccepted updates are rejected.
- Added unit test suite `tests/unit/roomRuntime.test.ts` covering ephemeral `CollabServer` startup, REST auth/room endpoints, multi-client WebSocket Yjs sync, concurrent `alloc-item` requests with retired ID preservation, `VIEWER` and `EDITOR` Yjs update rejections with corrective `sync-step2`, and crash recovery from uncompacted `yjs_updates` on reload.

### Decisions Made & Notes for Next Agent
- When `RoomRuntime.initialize()` recovers a room that has rows in `yjs_updates`, it applies those stored updates directly to the fresh `this.ydoc` (because compaction always retains a full-state snapshot as the base row in `yjs_updates`) rather than calling `workspaceToYDoc` first, which would otherwise create new root `Y.Map` instances with a different `clientID`.
- When a client receives a corrective `sync-step2` after an update rejection (`FORBIDDEN` / `CONFLICT` / `VALIDATION_ERROR`), calling `resetYDocToServerState(doc, Buffer.from(msg.updateBase64, 'base64'))` from `src/shared/collab/yjsDoc.ts` cleanly reverts unaccepted local Yjs operations in-place on the existing `Y.Doc` instance.
- `CollabServer` exposes `getPort()`, `getHost()`, `getProtocol()`, `getBaseUrl()`, `getWsBaseUrl()`, `getTlsInfo()`, `db`, `auth`, `rooms`, `runtimeManager`, and `wsHandler` so `DiscoveryBroadcaster` (T06), `CollabClient` (T07/T12), and `RevisionService` (T11) can integrate cleanly.

## T06 Implement UDP LAN discovery broadcaster and client listener

### What Changed
- Created `src/server/discovery.ts` implementing `DiscoveryBroadcaster`:
  - Broadcasts `{ magic: 'HLR_SERVER_BEACON_V1', serverId, name, version, host, port, tls, fingerprint, timestamp }` over IPv4 UDP to broadcast targets (`255.255.255.255` and `127.0.0.1`, default port `41234`).
  - Resolves advertised host (`resolveAdvertiseHost`) using non-internal IPv4 interfaces when bound to `0.0.0.0`, falling back to `127.0.0.1`.
  - Enforces 512-byte beacon size limit (`buildDiscoveryBeacon` and `serializeDiscoveryBeacon`), truncating long server display names if needed and ensuring `fingerprint` is `null` when `tls: false`.
- Integrated `DiscoveryBroadcaster` into `CollabServer` (`src/server/httpServer.ts`):
  - Added `discovery?: boolean`, `discoveryPort?: number`, `discoveryTargets?: readonly string[]`, and `discoveryIntervalMs?: number` to `CollabServerOptions`.
  - Automatically initializes, starts, and stops `discoveryBroadcaster` with `CollabServer.start()` and `CollabServer.stop()` unless `discovery: false` is configured.
  - Exposed `discoveryPort: number | null` on `CollabServerListenInfo` and `discoveryBroadcaster` on `CollabServer`.
- Updated `src/server/index.ts`:
  - Re-exported `DiscoveryBroadcaster`, `buildDiscoveryBeacon`, `serializeDiscoveryBeacon`, and `resolveAdvertiseHost`.
  - Added `--discovery-port <port>` and `--no-discovery` CLI argument parsing, environment variable support (`HLR_SERVER_DISCOVERY_PORT`, `HLR_SERVER_NO_DISCOVERY`), help text documentation, and discovery port status in startup console logs.
- Created `src/main/collab/discoveryClient.ts` implementing `DiscoveryClient`:
  - Listens for UDP beacons on default port `41234` or custom/ephemeral port (e.g. port `0`).
  - Validates incoming packets with Zod (`discoveryBeaconSchema`), silently discarding malformed JSON, oversized buffers (> 1024 bytes), wrong magic, or schema mismatches.
  - Resolves advertised host (falling back to remote sender address if loopback/wildcard on LAN).
  - Deduplicates discovered servers in a Map keyed by `serverId`.
  - Tracks `online: boolean` state, marking servers offline after `10s` (`DISCOVERY_STALE_MS` / `staleThresholdMs`) and reviving them upon subsequent beacon reception.
  - Emits typed events (`servers`, `server-discovered`, `server-updated`, `server-stale`) and provides `getServers()`, `getServer()`, `checkStale()`, `clear()`, `removeServer()`, and `onServersChange()`.
  - Binds with `reuseAddr: true` so multiple client processes can bind without `EADDRINUSE`.
- Added test suite `tests/unit/discovery.test.ts` (17 tests) covering beacon construction, size enforcement, packet filtering, ephemeral port localhost UDP broadcast and reception, deduplication, stale server tracking/revival, CollabServer lifecycle integration, CLI flag parsing, and options validation.

### Decisions Made & Notes for Next Agent
- `DiscoveryClient` accepts `port: 0` to bind to an OS-assigned ephemeral port (`client.getPort()`), allowing integration tests to run with complete isolation and zero port conflicts.
- `CollabServerOptions` defaults `discovery: true` and `discoveryPort: 41234`, targeting both `255.255.255.255` (LAN broadcast) and `127.0.0.1` (loopback) every `3000ms`. In tests or non-discovery scenarios, pass `discovery: false` or `--no-discovery`.
- `DiscoveryClient.getServers()` returns a sorted list (`online` servers first, then sorted by `lastSeenAt` descending, then by name) with `online` state dynamically checked against `now()`. Call `client.checkStale()` to check and fire `'server-stale'` events.
- For T07 (`CollabClient` and `DesktopService`), `DiscoveryClient` is ready to be instantiated in the Electron main process and exposed via `DesktopService` IPC methods for discovered server list queries and push notifications to the renderer.

## R01 Protocol and permissions v2, remove Yjs

### What Changed
- Uninstalled `yjs`, `y-protocols`, and `lib0` from `package.json` and `package-lock.json` using `--ignore-scripts --cache offline/cache/npm`. Verified `grep -ri "yjs" src tests` is completely empty.
- Deleted `src/shared/collab/yjsDoc.ts` and `tests/unit/yjsDoc.test.ts`.
- Updated `src/shared/collab/types.ts`:
  - Defined all 13 v2 `COLLAB_OP_KINDS` (`item.create`, `item.edit`, `item.delete`, `item.reorder`, `function.create`, `function.edit`, `function.editScope`, `function.delete`, `function.reorder`, `module.create`, `module.edit`, `module.delete`, `module.reorder`, `config.update`).
  - Defined operation payloads and envelope (`CollabOp`), op rejection error codes (`OP_REJECT_CODES`), lock types (`LockHolder`, `LockInfo`, `LockState`), presence types (`PresenceState`, `PresenceBroadcastEntry`), and all v2 WebSocket client and server messages (`WsClientMessage`, `WsServerMessage`).
- Updated `src/shared/collab/permissions.ts`:
  - Implemented `authorizeOp(role, op, lockState?, workspace?, actor?)` enforcing role capabilities (`VIEWER` cannot perform mutation ops; `EDITOR` cannot perform `config.update`, `module.delete`, or `function.delete`), target existence, lock ownership for `item.edit` and `function.editScope`, subtree locks preventing deletion when another user holds an active lock within the subtree, and immutability of `project.config.json` fields `projectId` and `version`.
- Updated `src/shared/collab/protocol.ts`:
  - Implemented strict Zod wire schemas for all v2 op payloads, `collabOpSchema`, `lockAcquireSchema`, `lockHeartbeatSchema`, `presenceStateSchema`, `presenceBroadcastEntrySchema`, and all `wsClientMessageSchema` and `wsServerMessageSchema` variants.
- Updated `src/server/db.ts`:
  - Replaced `yjs_updates` with `room_ops (room_id, seq, op_id, actor_id, op_kind, op_payload, created_at, PRIMARY KEY (room_id, seq), UNIQUE (room_id, op_id))` and added `materialized_seq INTEGER NOT NULL DEFAULT 0` to `rooms`.
- Updated `src/server/roomRuntime.ts` and `src/server/wsHandler.ts`:
  - Removed all Yjs imports and adapted to v2 message contracts, using static `WorkspaceIndex.rebuild(workspaceDir, this.workspace)` and adding `getBaseUrl()` and `getWsBaseUrl()` helpers to `CollabServer`.
- Updated `tests/unit/collabPermissions.test.ts` and `tests/unit/collabProtocol.test.ts`:
  - Added exhaustive coverage of `authorizeOp` across every role × op kind × lock state combination, expired leases, subtree locking, and malformed payload rejections.
  - Added schema validation tests for every v2 client and server WebSocket message type.
- Updated documentation in `docs/collab/PROTOCOL.md`, `docs/collab/PERMISSIONS.md`, `docs/collab/ARCHITECTURE.md`, and `docs/collab/TASKS.md`, marking superseded sections with warning banners pointing to `ARCHITECTURE-v2.md`.

### Decisions Made & Notes for Next Agent (R02)
- Server op engine in R02 will implement the per-room serial queue (`enqueueOp`), append to `room_ops` before broadcasting `op-applied` and acknowledging with `op-ack`, handle idempotent re-submission via `opId`, and implement catch-up via `ops-since` / `snapshot`.
- `WorkspaceIndex.rebuild(root, input)` in `src/main/db/sqliteClient.ts` is static and should be called directly followed by `index.close()`.
- All tests pass (`npm run typecheck`, `npm test` with 92/92 tests green and 100% domain coverage, `npm run build` succeeds).

## R02 Move server storage to PostgreSQL (store interface, migrations, async services)

### What Changed
- Installed pure-JS `pg@8.23.1` and `@types/pg@8.23.1` using `--ignore-scripts --save-exact` and updated `offline/cache/npm`. Client-side SQLite (`src/main/db`, `better-sqlite3`) remains untouched.
- Created `src/server/errors.ts`: Extracted `CollabServiceError` and `API_ERROR_HTTP_STATUS` into a standalone error module with zero SQLite dependencies.
- Created `src/server/store/types.ts`: Defined `ServerStore` interface, row models, and 12 asynchronous repositories (`users`, `sessions`, `serverSettings`, `rooms`, `memberships`, `invites`, `joinRequests`, `bans`, `audit`, `ops`, `snapshots`, `revisions`) with support for nested transactions.
- Created `src/server/store/migrations/0001_init.sql`: Full DDL covering `schema_migrations`, tables, foreign key constraints, timestamps, indexes (including lower(username) case-insensitive unique index), covering all server state plus `room_ops`, `room_snapshots`, and `revisions`.
- Created `src/server/store/migrator.ts`: Pure-JS/TS migration runner guarded by PostgreSQL advisory lock `pg_advisory_lock(8473927492837482n)` and tracking `schema_migrations`.
- Created `src/server/store/pgStore.ts`: Complete `PgServerStore` implementation connecting via `pg.Pool` or within a client transaction, mapping rows safely, and providing all repository methods with parameterized SQL.
- Created `src/server/store/index.ts`: Unified re-exports for store, types, migrations, and migrator.
- Converted server services to asynchronous and store-backed:
  - `src/server/auth.ts`: Converted `AuthService` to async and backed by `ServerStore`.
  - `src/server/rooms.ts`: Converted `RoomService` to async and backed by `ServerStore`. Removed server-side workspace JSON files on disk in favor of DB snapshots (`room_snapshots`).
  - `src/server/roomRuntime.ts` & `src/server/wsHandler.ts`: Converted `RoomRuntime` and `RoomRuntimeManager` to async and backed by `ServerStore`.
  - `src/server/httpServer.ts`: Converted `CollabServer` to async lifecycle, connecting to PostgreSQL, applying migrations, and serving REST and WebSocket endpoints.
  - `src/server/index.ts`: Added CLI arguments `--database-url`/`HLR_DATABASE_URL`, `--db-pool`/`HLR_DB_POOL`, and `--migrate-only`/`HLR_MIGRATE_ONLY`.
- Deleted `src/server/db.ts`: Verified `grep -rn "better-sqlite3\|server.sqlite" src/server` is completely empty.
- Created `scripts/test-db.mjs` and `tests/unit/testDbHelper.ts`: Spawns disposable `postgres:16-alpine` Docker container on a dynamic port or reuses `HLR_TEST_DATABASE_URL`. Provides isolated PostgreSQL schemas (`search_path`) per test suite with automatic drop-schema cleanup.
- Added comprehensive unit tests in `tests/unit/pgStore.test.ts` (10 tests) covering migrations idempotency, concurrent advisory lock mutual exclusion, transaction commit/rollback, and every repository method.
- Ported `tests/unit/serverAuth.test.ts`, `tests/unit/serverRooms.test.ts`, and `tests/unit/roomRuntime.test.ts` to async `ServerStore` against PostgreSQL with isolated schemas.
- Wired `scripts/run-tests.mjs` to automatically ensure a PostgreSQL test container before launching vitest.
- Updated `README.md` to document collaboration server configuration flags and PostgreSQL test prerequisites.
- Verified all 15 test files and 102 tests pass, `npm run typecheck`, `npm test`, and `npm run build` succeed with green coverage.

### Decisions Made & Notes for Next Agent (R03)
- In `testDbHelper.ts`, `createTestStore()` sets the schema search path via the pool's connection options (`options: -c search_path="${schema}",public`), guaranteeing clean schema isolation across concurrent test runners.
- `RoomService` now persists workspace snapshots in PostgreSQL (`room_snapshots`) and tracks sequence numbers in `rooms.head_seq` and `rooms.snapshot_seq`. Disk-based workspace JSON is no longer created on the server.
- The server op engine in R03 will implement per-room serial queue ordering, append to `room_ops` before broadcasting `op-applied` and acknowledging with `op-ack`, handle idempotent re-submission via `opId`, and implement catch-up via `ops-since` / `snapshot`.



## R03 Server operation engine (2026-10-17)

### What changed
- Replaced the placeholder runtime that logged operations without applying them. A room now authorizes operations against current membership and active locks, applies domain changes, and commits the operation log and head sequence in one PostgreSQL transaction under a room row lock. Only committed changes update memory, broadcast, or receive an acknowledgement.
- Added deterministic operation results (server-generated node/item identity and timestamps), duplicate retry handling, rejection messages, and recovery from the latest snapshot plus all later operations. Reusing an operation ID for different content is rejected. A second stale server runtime cannot overwrite the persisted head.
- Added fast immutable item patches and description updates. Patches preserve unmodified columns and validate changed values/references. Existing hierarchy, ID allocation, settings and deletion services remain reused; structural operations still inherit their existing whole-workspace validation, while the frequent typing path avoids it.
- Catch-up returns ordered log entries or a full snapshot when entries are missing, pruned, or exceed the response limit. REST room loading/export uses the same recovery path, including before the first WebSocket joins after restart.
- Snapshots update snapshot_seq atomically, retain the latest three versions, run after 2 seconds idle / 10 seconds maximum, and flush on close. Snapshot failures are reported without losing committed operations.
- Wired lock-granted/denied responses and awaited WebSocket lock handlers; disallowed viewer lock acquisition and non-admin forced release. Full lease lifecycle, reconnect grace, auditing and presence remain R04.
- Fixed the test database port allocator's unbounded retry on permission errors. Fixed the CLI integration test to supply an isolated PostgreSQL schema.

### Validation
- `npm run typecheck` and `npm run build` pass.
- Full `npm test` passes against real PostgreSQL 16.15: 108 tests, 16 files. All four protected core modules retain 100% statement/branch/function/line coverage.
- Five real WebSocket connections submit 50 concurrent adds: unique IDs and ordered sequences, identical reconstructed client workspaces, idempotent retries, rejection of changed retry payloads, restart recovery before snapshotting, REST recovery, catch-up and missing/pruned-log snapshot fallback.
- Database constraint failure proves transaction rollback preserves memory, sequence and log and does not poison the queue. Viewer and lockless edits are rejected.
- The 10,000-item patch benchmark passes the 5 ms limit for domain application (excluding database/network latency).
- Docker access was unavailable. Tests used an official PostgreSQL package extracted into `/tmp`, with an isolated localhost database; no system installation or production database changes.

### Remaining plan
- R04 is next: full lease lock manager and presence. T07–T10 connect the desktop client and collaboration UI. T11–T14 cover revisions, reconnect/drafts, offline deployment and full product end-to-end testing.
- `room.restore` currently rejects explicitly rather than logging an unimplemented change; implementation belongs to T11.
- Existing unrelated edits in package.json, build-preload.mjs, run-server.mjs and migrator.ts were preserved.
