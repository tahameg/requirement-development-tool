#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
npm run setup:desktop
npm run prepare:native
npm run build
npm run package:linux
npm run package:windows
