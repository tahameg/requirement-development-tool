#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node offline/bundle.mjs "${1:-linux}"
