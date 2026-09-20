#!/usr/bin/env bash
# Compatibility entry: both commands share port, readiness and cleanup behavior.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/start.mjs" "$@"
