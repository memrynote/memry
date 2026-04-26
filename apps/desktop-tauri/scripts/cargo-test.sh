#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

cargo_args=(--features test-helpers)
test_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --test)
      shift
      pattern="${1:?missing value for --test}"
      shopt -s nullglob
      matches=(tests/${pattern}.rs)
      shopt -u nullglob
      if ((${#matches[@]} > 0)); then
        for file in "${matches[@]}"; do
          cargo_args+=(--test "$(basename "$file" .rs)")
        done
      else
        cargo_args+=(--test "$pattern")
      fi
      ;;
    *)
      test_args+=("$1")
      ;;
  esac
  shift
done

if ((${#test_args[@]} > 0)); then
  cargo_args+=(-- "${test_args[@]}")
fi

exec cargo test "${cargo_args[@]}"
