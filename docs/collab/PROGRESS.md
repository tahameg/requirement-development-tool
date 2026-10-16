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
