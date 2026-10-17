# Collaboration architecture

The earlier Yjs/SQLite server design has been **replaced** by [ARCHITECTURE-v2.md](ARCHITECTURE-v2.md). This document describes the surrounding account, security and desktop integration contracts. See [DEPLOYMENT.md](DEPLOYMENT.md) for installation and backup.

## Components

The Electron renderer remains sandboxed, context-isolated, and unable to use Node or fetch network content. Its validated preload bridge exposes a collaboration command interface and state subscription. `CollabClient` in the main process owns credentials, pinned HTTPS/WSS connections, the room mirror, lock heartbeats, reconnect and the on-disk draft. Session tokens never enter renderer state and are not persisted.

The headless Node server uses `pg` and `ws`. PostgreSQL is the single source of truth for users, sessions, rooms, memberships, invites, join requests, bans, operations, snapshots, revisions and audit entries. The TLS certificate/private key remain in the configured server data directory. The desktop's offline mode retains its existing JSON workspace and SQLite search index; the headless server has no native SQLite dependency.

`RoomRuntime` serializes changes per room, verifies current membership and session locks, applies domain commands, commits the operation plus room head in a row-locked transaction, then publishes it. Snapshots are an optimization; recovery always replays later committed operations. Clients apply sequence-ordered changes and request catch-up or receive a replacement snapshot after gaps.

## Accounts and permissions

Accounts belong to one server. The first owner claims the one-time setup token printed at startup. Passwords use scrypt; opaque session tokens are stored hashed with expiry. Registration is open, approval-based, or closed. Server administrators manage accounts and resolve room ownership; the owner controls server policy and administrator promotion.

Rooms are private or listed. Listed rooms accept join requests. Direct invitations and expiring/limited-use invite codes grant membership. Room owners transfer ownership or delete rooms. Room admins manage members, revisions, settings and destructive hierarchy changes. Editors author items, hierarchy and scope; viewers read, see presence and export. The complete enforcement matrix is in [PERMISSIONS.md](PERMISSIONS.md). UI controls reflect capabilities, but every operation is authorized on the server.

## Security and discovery

Servers use HTTPS/WSS by default with a generated self-signed certificate. The desktop first probes the certificate without credentials, shows its SHA-256 fingerprint, and pins it only after confirmation. Every subsequent HTTP/WebSocket socket is verified before it becomes available for sending requests. A mismatch blocks credentials until explicit retrust. HTTP requires an explicit test-network acknowledgement.

LAN discovery broadcasts UDP beacons on port 41234. Discovery metadata is untrusted: it suggests an address, never establishes certificate trust. Manual addresses are always supported. Renderer CSP and navigation/network restrictions remain strict because all server networking lives in the main process.

## Editing and presence

An item, function scope, node properties or project configuration is edited while holding its lease lock. Locks belong to a login session, expire after 30 seconds without heartbeat, and survive disconnection for a 30-second grace period. Active clients heartbeat every 10 seconds. Viewers cannot acquire locks. Administrators can force release them with an audit entry and a notice to the holder. Deletes remove obsolete locks; restores release all locks. Presence is limited to 10 broadcasts/second per connection and includes the latest view, focused field and new-item drafting state.

Rows keep a local draft; changed-column patches are sent after 300 ms idle and on blur/commit. New items consume no ID until a valid commit. The main process persists the current row or scope draft. While disconnected the view becomes read-only. Automatic reapply requires an unchanged base and reclaimable lock; otherwise a comparison preserves the draft for explicit review. There is no persistent queue of offline room operations. Export to a local JSON workspace is the supported offline authoring flow.

## Revisions and ID safety

A named revision is an immutable PostgreSQL workspace snapshot plus author, timestamp and room operation sequence. Multiple named revisions may refer to the same operation head. All members can inspect revision history and diffs; only room admins/owners save, restore or import.

Restore runs in the same queue as edits and creates a new revision. Its operation result stores the resolved workspace so replay is deterministic. Function watermarks never decrease. Retired IDs merge current/target ledgers and IDs issued in newer history, excluding IDs restored as live items. Subsequent allocation cannot reuse an ID issued before the restore. Import accepts a local copy of the same project; a different project belongs in a new room.
