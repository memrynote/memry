#!/usr/bin/env bash
set -euo pipefail

ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null || true
exec "$@"
