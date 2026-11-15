#!/usr/bin/env bash
# Prints the Rust modules that only some OSes compile, one `<path prefix>\t<win|mac|both>` line per
# `#[cfg(<os>)] mod x;` (or `#[cfg(...)] #[path = "..."] mod x;`) under the checkout at $1. A changed
# file is in such a module when it is `<prefix>.rs` or under `<prefix>/`. A cfg that only Linux
# satisfies prints nothing (the fast tier builds Linux); a `not(...)` of an OS prints `both`.
# Prints nothing and exits 1 when the checkout holds no Rust sources, so tier.sh fails open.
# scripts/ci-tier.test.mjs runs this file on fixtures and on the repo itself.
set -euo pipefail
cd "$1"
dirs=()
for d in crates apps/desktop-tauri/src-tauri; do [ -d "$d" ] && dirs+=("$d"); done
[ "${#dirs[@]}" -gt 0 ] || exit 1
list=$(find "${dirs[@]}" -name target -prune -o -name '*.rs' -print)
[ -n "$list" ] || exit 1
printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 awk '
  function osclass(c,   win, mac) {
    if (c !~ /(windows|unix|target_os|target_family|target_env)/) return ""
    if (c ~ /not[ \t]*\(/) return "both"
    win = (c ~ /(windows|msvc)/)
    mac = (c ~ /(macos|"ios"|apple|darwin|unix)/)
    if (win && mac) return "both"
    if (win) return "win"
    if (mac) return "mac"
    return ""
  }
  FNR == 1 { cfg = ""; acc = ""; path = "" }
  {
    line = $0
    if (acc != "") {
      acc = acc " " line
      if (line ~ /\][ \t]*$/) { cfg = acc; acc = "" }
      next
    }
    if (line ~ /^[ \t]*#\[cfg\(/) {
      if (line ~ /\][ \t]*$/) cfg = line; else acc = line
      next
    }
    if (line ~ /^[ \t]*#\[path[ \t]*=/) {
      path = line; sub(/^[^"]*"/, "", path); sub(/".*$/, "", path)
      next
    }
    # Other attributes and comments between the cfg and the `mod` keep the cfg pending.
    if (line ~ /^[ \t]*(#\[|\/\/)/) next
    if (cfg != "" && line ~ /^[ \t]*(pub(\([^)]*\))?[ \t]+)?mod[ \t]+[A-Za-z0-9_]+[ \t]*;/) {
      os = osclass(cfg)
      if (os != "") {
        name = line
        sub(/^[ \t]*(pub(\([^)]*\))?[ \t]+)?mod[ \t]+/, "", name); sub(/[ \t]*;.*$/, "", name)
        dir = FILENAME; sub(/\/[^\/]*$/, "", dir)
        base = FILENAME; sub(/^.*\//, "", base)
        if (path != "") {
          prefix = dir "/" path
          if (prefix ~ /\/mod\.rs$/) sub(/\/mod\.rs$/, "", prefix); else sub(/\.rs$/, "", prefix)
        } else if (base == "mod.rs" || base == "lib.rs" || base == "main.rs") {
          prefix = dir "/" name
        } else {
          sub(/\.rs$/, "", base)
          prefix = dir "/" base "/" name
        }
        print prefix "\t" os
      }
    }
    cfg = ""; path = ""
  }
'
