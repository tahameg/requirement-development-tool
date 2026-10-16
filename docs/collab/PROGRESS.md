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
