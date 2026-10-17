# HLR Writing Tool

An offline-first desktop requirements authoring tool. `Agents.md` is the product and architecture specification.

## Current milestone

**Phases 1–5 are implemented, with Phase 6 packaging and offline tooling.** The application now launches as a standalone Electron window with a React/Vite interface.

- Create a project in a new workspace directory or open an existing workspace.
- Reopen recent projects, save with **Ctrl+S**, and edit project name, prefix, and ID casing.
- Store application theme, autosave preference, window geometry, and recent paths in the system `config.ini`.
- Rebuild a local `better-sqlite3` index from JSON on opening and saving, including FTS5 tables. Missing or corrupt caches are replaceable; cache failures are shown without discarding the JSON workspace.
- Keep filesystem and database access behind validated IPC calls. The renderer uses context isolation, sandboxing, no Node integration, a bundled CommonJS preload, and a strict local-assets-only Content Security Policy. Network requests, navigation, new windows, and permission requests are denied.
- Retain Phase 1 immutable IDs, schema validation, human-readable persistence, and interrupted-save recovery.

The sidebar now opens **Requirements, Data Dictionary, Entity and Action**. Open or create a project, select an object type, and use **Add module**. Inside a module, add submodules or function groups. Functions use a distinct **ƒx** badge and cannot contain further groups. **Properties** edits names, prefixes and scope descriptions. Use the row’s **⋯** menu or right-click for context actions.

The tree expands/collapses and filters by name, prefix or item ID. Arrow keys navigate it; Enter selects a node. Breadcrumbs let you return to ancestors. Function views show the next available ID and an editable item table. Module/function mutations persist immediately and refresh the SQLite index. Deleting a module requires confirmation, removes its descendants, and retires all contained item IDs. Duplicate function names in the same module are rejected. Existing item IDs remain unchanged when prefixes or names change.

## Writing and searching

Select a function and click **Add requirement** (or **Add item** for other types). A pending row appears with defaults and an ID preview. Fill required fields and choose **Save changes** or press **Ctrl+S**. IDs are allocated when a valid row is saved; cancelling an unsaved row does not consume an ID. Click any cell to edit its row. **Cancel edits** discards the current draft; saved row deletions require confirmation and permanently retire the ID. The table renders a window of rows so large functions remain usable.

Function scope supports Markdown editing and a preview. Raw HTML is ignored; images and links cannot fetch remote content. Valid drafts autosave after the configured idle interval (0 disables autosave). Invalid drafts remain open with a validation error. Navigating away prompts before discarding drafts, and closing/reloading the desktop window protects unsaved edits.

**Project settings** includes object enablement, object prefixes, ID casing, and a column designer. Add, remove, reorder and configure text, Markdown, number, date, boolean, dropdown, or reference fields, including defaults and required rules. Newly added defaults fill existing rows. System columns cannot be removed or have their type/required rule weakened. Removing another column requires confirmation and deletes its values on save. Incompatible type/required changes reject the whole settings update.

Add a **reference** column to choose items from Data Dictionary, Entity and Action. Reference cells have a filterable picker and an arrow to open the target. Missing or wrong-type references are rejected; a referenced target or containing group cannot be deleted until incoming links are cleared.

Use **Ctrl+P** or **Ctrl+F** for SQLite full-text search across IDs, function names and field values. Click a result to open its function and highlight the item. Queries match literal words/phrases, and results are capped at 100. A 10,000-item benchmark is tested against the roadmap’s 50 ms search threshold.

Export the current function or entire workspace as **CSV** or **Markdown** using native save dialogs. CSV quotes embedded delimiters/newlines and prefixes formula-like values with an apostrophe for spreadsheet safety. Markdown escapes table delimiters and HTML. Exports use stable column IDs internally and readable column names in headers.

## Distribution and offline development

Build targets are Linux x64 **AppImage** and **deb**, plus Windows x64 **portable EXE** and **NSIS offline installer**. Outputs are written to `release/`. The NSIS installer is per-user and installs shortcuts and an uninstaller without downloading anything. Its uninstaller removes only shipped files; user workspaces and application settings are retained. Windows binaries are unsigned, and execution on a real Windows machine still needs validation.

```sh
npm run prepare:native
npm run build
npm run package:appimage  # Package standalone Linux AppImage
npm run package:deb       # Package Debian/Ubuntu installer
npm run package:linux     # Package both AppImage and deb
npm run package:windows   # Package Windows portable and NSIS installer
```

### Container image building

To build the application and its artifacts within an isolated container environment:

```sh
docker build -t hlr-writing-tool .
```

The connected preparation step caches verified ABI-specific SQLite binaries for both targets. Packaging disables implicit native rebuilds and checks native-binary manifests before switching platforms. Do not run platform packaging commands concurrently. For source/dependency/Node/Electron bundles, follow [offline/README.md](offline/README.md). They include their own Node/npm runtime, installed platform dependencies and build caches, so `npm install` is not needed on the offline target.

A packaged self-test can be run as `hlr-writing-tool --smoke-test` (or the equivalent Windows executable). It uses disposable settings and a disposable workspace. Linux was also tested inside a network namespace with no network interface; its renderer, sandboxed preload, local SQLite, JSON persistence, search, export and corrupt-cache recovery passed. The desktop libraries and sandbox support provided by the host OS remain prerequisites; no AppImage bundles an entire operating system.


## Development

This checkout was built and tested on Linux with Node.js 20.20.2, npm 10, Electron 40.10.2 and SQLite through `better-sqlite3` 12.8.0. Dependencies are pinned in the lockfile. The Electron version is pinned for compatibility with the current Node.js development runtime; reassess supported Electron and Node versions before distribution.

```sh
npm ci --ignore-scripts
npm run setup:desktop
npm run typecheck
npm test
npm run build
npm start
```

`setup:desktop` is an explicit **connected-machine preparation step**: it downloads the Electron runtime and obtains/builds the SQLite module for Electron's ABI. A source build may require Python and a C++ toolchain (Visual Studio Build Tools on Windows). Package lifecycle scripts are disabled during installation; binary preparation is intentional and separate.

Once prepared, tests, builds and the app work locally without downloading runtime assets. There is no runtime web server. `npm start` loads the built renderer from disk, so rebuild after source changes.

`npm test` uses Electron's bundled Node runtime so SQLite tests use the same native ABI as the desktop application; do not rebuild SQLite for your system Node runtime afterward. `npm run test:desktop` launches the real Electron window, exercises the UI and preload, and checks project creation/opening, settings, SQLite, reloads and network blocking. It requires a graphical session and creates only disposable test workspaces. Its screenshot is written to the system temporary directory as `hlr-desktop-smoke.png`.

`npm run test:hierarchy` runs a second real-window regression test: all four sidebar roots, nested module/function creation, duplicate-name validation, breadcrumbs, keyboard navigation, search by item ID, properties, ID immutability, deletion confirmation and persistence after reopening. Its screenshot is saved as `hlr-hierarchy-smoke.png` in the system temporary directory. The suite now has 25 unit tests; the original core ID and validation coverage thresholds remain enforced.

`npm run test:authoring` checks required fields, immutable add/edit/delete behavior, safe Markdown, a custom reference column, link navigation, reference deletion protection, full-text search, exports and reloads in the actual desktop UI.

Application settings are written to `$XDG_CONFIG_HOME/hlr-writing-tool/config.ini` (default `~/.config/hlr-writing-tool/config.ini`) on Linux and `%APPDATA%\hlr-writing-tool\config.ini` on Windows. Invalid settings are reported at startup rather than overwritten. No fonts, scripts, icons or styles are loaded from a CDN; the interface uses system fonts.

## Collaboration Server & PostgreSQL

The server component (`npm run server`) provides multi-user real-time room collaboration. Server storage is backed by PostgreSQL using pure-JavaScript `pg` (no native C++ build steps required). Client-side desktop storage remains local SQLite via `better-sqlite3`.

The v2 server operation engine is implemented: ordered edits, permission checks, transactional acknowledgements, idempotent retries, snapshot/log recovery, and catch-up are tested with real WebSocket clients. **The desktop collaboration connection and room UI are not implemented yet.** Follow [the collaboration task plan](docs/collab/TASKS.md); R04 (full lock/presence lifecycle) is next, followed by the client connection and UI tasks. The existing desktop continues to work offline.

### Server Configuration Flags & Environment Variables

| CLI Flag | Environment Variable | Default | Description |
|---|---|---|---|
| `--database-url <url>` | `HLR_DATABASE_URL` / `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `--db-pool <count>` | `HLR_DB_POOL` | `10` | Maximum connection pool size |
| `--migrate-only` | `HLR_MIGRATE_ONLY=1` | `false` | Run advisory-locked database migrations and exit |
| `--host <host>` | `HLR_SERVER_HOST` | `0.0.0.0` | Bind host address |
| `--port <port>` | `HLR_SERVER_PORT` | `8443` | Bind port number (`0` for ephemeral) |
| `--insecure-http` | `HLR_SERVER_INSECURE_HTTP=1` | `false` | Use plain HTTP/WS instead of HTTPS/WSS |
| `--name <name>` | `HLR_SERVER_NAME` | `HLR Collaboration Server` | Server display name in discovery |
| `--data-dir <dir>` | `HLR_SERVER_DATA_DIR` | `.hlr-server-data` | Directory for TLS certificates |
| `--setup-token <tok>` | `HLR_SERVER_SETUP_TOKEN` | *(random)* | Initial setup token for first SERVER_OWNER claim |
| `--registration-mode` | `HLR_SERVER_REGISTRATION_MODE` | `open` | `open`, `approval`, or `closed` |
| `--room-creation-mode` | `HLR_SERVER_ROOM_CREATION_MODE` | `all_users` | `all_users` or `admins_only` |
| `--no-discovery` | `HLR_SERVER_NO_DISCOVERY=1` | `false` | Disable UDP LAN discovery broadcaster |
| `--discovery-port <p>` | `HLR_SERVER_DISCOVERY_PORT` | `41234` | UDP discovery broadcast target port |

### Test Prerequisites

When running `npm test`:
- `scripts/run-tests.mjs` automatically invokes `scripts/test-db.mjs` to spawn a disposable `postgres:16-alpine` Docker container on a dynamic port. Each test suite runs in its own isolated PostgreSQL schema with advisory locks and cleans up after itself.
- If Docker is not available in your environment, export `HLR_TEST_DATABASE_URL` pointing to any accessible PostgreSQL 16+ instance:
  ```sh
  export HLR_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/postgres
  npm test
  ```
  The test helper creates uniquely named schemas (e.g. `test_...`) and drops them on completion without altering other databases.

Linux packaged execution is verified. Windows cross-builds and target-specific offline bundles are prepared here, but their execution and installation must be checked on a Windows x64 desktop.

## Core API example

After building, run this as an ES module from the project root:

```js
import { createWorkspace, addModule, addFunction } from './dist/main/services/workspaceFactory.js';
import { addItem } from './dist/main/services/idGenerator.js';
import { saveWorkspace, loadWorkspace } from './dist/main/services/workspaceService.js';

let workspace = createWorkspace('Guidance System', 'GS');
workspace = addModule(workspace, 'REQUIREMENT', 'Compiler', 'COMPL');
const moduleId = workspace.domains.REQUIREMENT.modules[0].id;
workspace = addFunction(workspace, 'REQUIREMENT', moduleId, 'Create parser', 'CREATE');
const functionId = workspace.domains.REQUIREMENT.functions[0].functionId;
workspace = addItem(workspace, 'REQUIREMENT', functionId, {
  col_desc: 'The parser shall reject invalid input.',
});
await saveWorkspace('./Guidance.hlr', workspace);
const restored = await loadWorkspace('./Guidance.hlr');
console.log(restored.domains.REQUIREMENT.functions[0].items[0].id);
// REQ-GS-COMPL-CREATE-001
```

Files and SQLite access belong exclusively in the Electron main process. The renderer calls typed IPC rather than importing these services.

## Workspace format and guarantees

Each workspace contains `project.config.json` and four domain directories: `requirements`, `data-dictionary`, `entities`, and `actions`. Each domain contains `modules.json` and a `functions` directory. Function files use stable internal UUIDs in their filenames and contain their metadata, description, watermark, and items. All JSON is indented with two spaces.

`retired-ids.json` is an additional project-wide tombstone ledger. It prevents a deleted ID being reused by another function after prefix or hierarchy changes. Older external workspaces without this file are accepted with an empty ledger; previously deleted IDs cannot be recovered if both their watermark and tombstone history have been removed. Never lower stored watermarks or discard tombstones when converting data.

Loading validates shapes, columns and values, parent references, cycles, uniqueness, and ID/sequence agreement. Stale watermarks are raised to the largest surviving sequence. Module name paths are derived from stable parent IDs. Existing item IDs are never reconstructed from current prefix settings.

Saves validate a complete snapshot before writing. A flushed `.hlr/pending-save.json` stores the intended snapshot before individual JSON files are atomically replaced. Opening the workspace replays an interrupted save. Invalid recovery journals cause an error rather than being silently discarded. This provides process-interruption recovery; full power-loss durability and filesystem fault guarantees are not claimed. Abandoned uniquely named `.tmp` files are ignored.

Use a single writer per workspace. Calls are serialized within this process; cross-process locking and conflict detection for external edits are not implemented. A full snapshot save replaces the workspace's managed files, so reload external changes before saving. Persist a returned transaction before exposing it as committed to the UI. Required values must be provided when committing an item. The editor keeps incomplete new rows in a separate in-memory draft state and protects them against accidental navigation.
