#!/usr/bin/env bash
# Prints the Rust modules that only some OSes compile, one `<path prefix>\t<win|mac|both>\t<file>:<line>`
# line per `#[cfg(<os>)] mod x;` (or `#[cfg(...)] #[path = "..."] mod x;`) under the checkout at $1,
# the last field naming the declaration. A changed file is in such a module when it is `<prefix>.rs`
# or under `<prefix>/`. An inline `#[cfg(<os>)] mod x { ... }` prints its file as the prefix: any
# change to that file counts, since a diff's hunk headers do not say which module a line is in. A cfg that only Linux
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
  # The end of the attribute that opens `s` (its closing `]`), or 0 when it ends on a later line.
  function attr_end(s,   i, c, depth, quoted) {
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (quoted) { if (c == "\\") i++; else if (c == "\"") quoted = 0; continue }
      if (c == "\"") quoted = 1
      else if (c == "[") depth++
      else if (c == "]" && --depth == 0) return i
    }
    return 0
  }
  # `s` without a `//` comment outside a string.
  function uncomment(s,   i, c, quoted) {
    for (i = 1; i < length(s); i++) {
      c = substr(s, i, 1)
      if (quoted) { if (c == "\\") i++; else if (c == "\"") quoted = 0; continue }
      if (c == "\"") quoted = 1
      else if (c == "/" && substr(s, i + 1, 1) == "/") return substr(s, 1, i - 1)
    }
    return s
  }
  FNR == 1 { cfg = ""; acc = ""; path = "" }
  {
    line = uncomment((acc != "" ? acc " " : "") $0); acc = ""
    # Attributes, on their own lines or before the item, gather the cfgs and the path that apply
    # to the next item; comments and blank lines between them keep those pending.
    while (line ~ /^[ \t]*#\[/) {
      e = attr_end(line)
      if (e == 0) { acc = line; next }
      attr = substr(line, 1, e); line = substr(line, e + 1)
      if (attr ~ /^[ \t]*#\[cfg[ \t]*\(/) cfg = cfg " " attr
      else if (attr ~ /^[ \t]*#\[path[ \t]*=/) { path = attr; sub(/^[^"]*"/, "", path); sub(/".*$/, "", path) }
    }
    if (line ~ /^[ \t]*$/) next
    if (cfg != "" && match(line, /^[ \t]*(pub(\([^)]*\))?[ \t]+)?mod[ \t]+[A-Za-z0-9_]+/)) {
      os = osclass(cfg)
      name = substr(line, RSTART, RLENGTH); sub(/^.*mod[ \t]+/, "", name)
      if (os == "") {
      } else if (substr(line, RSTART + RLENGTH) !~ /^[ \t]*;/) {
        # An inline module (`mod x { ... }`): the whole file stands for it.
        print FILENAME "\t" os "\t" FILENAME ":" FNR
      } else {
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
        print prefix "\t" os "\t" FILENAME ":" FNR
      }
    }
    cfg = ""; path = ""
  }
'
