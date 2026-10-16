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
