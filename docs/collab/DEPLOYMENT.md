# Collaboration server deployment

The desktop works offline without a server. For collaboration, clients connect to a self-hosted Node.js server backed by PostgreSQL 16 or newer. The server bundle uses pure JavaScript; it does not need Electron, SQLite, a compiler, npm, a CDN or internet access at runtime.

## Prepare on a connected computer

Run `npm run build` and `node scripts/bundle-server.mjs`. Copy `release/server` to the offline server. Also copy a verified official Node.js 20+ runtime for the target OS/architecture and PostgreSQL 16+ installation packages with their OS dependencies. Install PostgreSQL from those offline OS packages. This preparation does not install anything on the destination automatically. Use the existing `offline/` desktop bundles for client installation.

Keep `server.mjs`, `migrations/`, and the Node runtime together. The supplied SHA-256 file verifies the server entry. Migrations are embedded as adjacent SQL files and applied automatically, once, under a database advisory lock. Back up the database before upgrading. Never edit an applied migration.

## Run directly (Linux or Windows)

Create a PostgreSQL role and database dedicated to HLR, then set:

```
HLR_DATABASE_URL=postgres://hlr:URL_ENCODED_PASSWORD@127.0.0.1:5432/hlr
HLR_SERVER_DATA_DIR=/var/lib/hlr-server
HLR_SERVER_HOST=0.0.0.0
HLR_SERVER_PORT=8443
```

Use an appropriate writable data directory on Windows. Protect database credentials with OS file permissions. Run `node server.mjs --migrate-only` to apply migrations separately, then `node server.mjs`. Preserve the data directory: it contains the server TLS certificate and private key. PostgreSQL holds accounts, rooms, operations, snapshots, revisions and audit history.

The first launch prints a one-time setup token. In the desktop choose **Connect to server**, enter `https://SERVER_IP:8443`, verify the displayed certificate fingerprint with the server administrator, then claim ownership with that token. Other users register or are created by an administrator according to the configured registration policy. Accounts are per server.

Open TCP 8443 between clients and server. LAN discovery uses UDP 41234; broadcasts do not cross routed networks. Manual address entry always works. HTTPS/WSS is the default. `--insecure-http` is only for explicitly accepted test networks. A changed certificate blocks requests until the user reviews and trusts the new fingerprint; credentials are not sent before verification.

For systemd, create an `hlr` service user, install the bundle at `/opt/hlr-server`, place Node at `/opt/hlr-server/node/bin/node`, and create `/var/lib/hlr-server` owned by that user. Put the variables above in `/etc/hlr-server.env` (root-owned, mode 600), install `hlr-server.service`, and enable/start it. Logs and the initial setup token are available in the journal.

## Containers on an air-gapped host

On a connected machine:

```
docker build -f deploy/Dockerfile.server -t hlr-server:0.6.0 .
docker pull postgres:16-alpine
docker save -o hlr-images.tar hlr-server:0.6.0 postgres:16-alpine
```

Transfer `hlr-images.tar` and `deploy/compose.yaml` to the offline machine. Load images with `docker load -i hlr-images.tar`. Create a protected `.env` beside the compose file containing `HLR_DB_PASSWORD` and `HLR_DATABASE_URL=postgres://hlr:URL_ENCODED_PASSWORD@database:5432/hlr`. Run `docker compose -f compose.yaml up -d --pull never`. The PostgreSQL port is not published. Named volumes preserve the database and TLS key. Bridged containers disable LAN broadcasts; connect by manual IP. Use `docker compose logs server` for the setup token. Do not run `down -v` unless intentionally deleting all server data.

## Backup and restore

Back up PostgreSQL using `pg_dump --format=custom --file=hlr.dump "$HLR_DATABASE_URL"`. Also back up the TLS data directory and protected service configuration. The database dump is a consistent snapshot, including acknowledged operations that have not yet been compacted. Store backups with restricted access.

To restore, stop the HLR server, create an empty destination database, run `pg_restore --no-owner --dbname=DESTINATION_URL hlr.dump`, restore the TLS directory and configuration, and start the server. Verify login, rooms, revisions and exports before returning it to users. Test recovery on a separate database periodically. Do not restore over a running server.

## Working together

Editors acquire a row or scope lock before editing. Row patches are shared after 300 ms idle, on blur, Enter or Save; newly added items get an ID only after a valid commit. Locks expire after 30 seconds without heartbeat and survive short network interruptions for 30 seconds. Administrators can force release locks. Presence shows viewers and active fields.

Every acknowledged change is committed to PostgreSQL. Autosave compacts the operation log into snapshots; **Save revision** creates an immutable named checkpoint. Restoring creates another revision, releases locks, preserves issued IDs and prevents future reuse. Import accepts a local copy of the same project; use **Create a room → Choose local workspace** for a different project.

Disconnected rooms are read-only. A row or function-scope draft is retained on disk under the desktop profile. Reconnecting reclaims the session lock and resends only when the original row is unchanged. Otherwise the draft is shown beside the current row for explicit review. Any member can export a room as a normal local JSON workspace and continue offline.
