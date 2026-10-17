# Offline preparation and use

Run connected preparation on a trusted Linux x64 build machine using `bash offline/download-deps.sh`. It installs pinned dependencies with package lifecycle scripts disabled, explicitly installs Electron/rebuilds host SQLite, caches the Windows SQLite prebuild, and downloads the packaging resources for both systems. It does not publish anything.

Then run `bash offline/package-offline-bundle.sh linux` and `bash offline/package-offline-bundle.sh win32`. Each archive contains source, target-specific installed npm dependencies, Electron, the native SQLite module, a complete Node/npm toolchain, packaging caches, and file checksums. Native manifests pin Electron version/ABI, platform/architecture, SQLite version, source and SHA-256. Node archives are checked against the official Node release SHA-256 manifest.

Transfer the archive and its `.sha256` file to the disconnected machine and verify the archive hash before extraction. Use the included `dev.sh` on Linux or `dev.cmd` on Windows, for example:

```
./dev.sh run build
./dev.sh test
./dev.sh start
./dev.sh run package:linux
```

On Windows use `dev.cmd` instead of `./dev.sh` and `package:windows` instead of `package:linux`. `toolchain\node-v20.20.2-win-x64\node.exe offline\verify.mjs` (or `./toolchain/node-v20.20.2-linux-x64/bin/node offline/verify.mjs`) verifies the extracted files before your first build. Once you edit/build, checksum changes are expected.

**Do not run `npm ci`, `setup:desktop`, or `prepare:native` on the disconnected machine.** The dependency tree and native binaries are already installed. Those commands are connected preparation commands. Never rebuild SQLite with system Node; it targets Electron's ABI. Do not run platform package builds concurrently: Windows packaging temporarily switches the native binding and restores it atomically afterward.

Bundle preparation uses `tar`; it is included with current Windows installations and standard Linux distributions. Windows can extract the resulting archive with `tar -xzf`. Native compilation tools are only needed for connected preparation if a platform prebuild is unavailable.

The bundles include application/build dependencies, not an entire operating system. Electron on Linux still needs the host desktop libraries (GTK, NSS, X11/Wayland, audio libraries, glibc) and working Chromium sandbox support. AppImage can be run with `--appimage-extract-and-run` if FUSE is unavailable; do not disable its sandbox. Debian packages declare required system libraries, which must also be available locally to install offline. Windows artifacts target x64 desktop Windows. Unsigned Windows binaries may require local trust approval.

A build produced on Linux does not verify Windows execution. Check the main README for the actual verification status of each artifact. Maintainer metadata describes a local development build; the Debian homepage points to its bundled README instead of inventing a public project website or contact address.

## Collaboration server

Prepare a standalone server using `npm run bundle:server`. It contains pure-JavaScript application dependencies and migration SQL; supply a verified Node.js runtime and offline PostgreSQL packages for the destination OS. The existing development bundle already includes Node. See [server deployment](../docs/collab/DEPLOYMENT.md) for service setup, offline container image transfer and database backup/restore. Full tests require PostgreSQL: set `HLR_TEST_DATABASE_URL` on an offline test machine instead of allowing the test helper to start a Docker image.
