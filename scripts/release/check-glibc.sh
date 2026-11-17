#!/bin/sh
# Fails when an ELF file under the given directories needs a glibc symbol version newer than
# GLIBC_2.35 (Ubuntu 22.04, the oldest glibc the Linux release supports), or when there is no ELF
# file to check. Prints the newest version each file needs and the newest overall.
# Usage: check-glibc.sh <dir>...
set -eu

max_allowed=2.35
[ $# -gt 0 ] || { echo "usage: check-glibc.sh <dir>..." >&2; exit 2; }
for dir in "$@"; do
  [ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 2; }
done

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
find "$@" -type f > "$list"

newest=0
checked=0
failed=0
while IFS= read -r file; do
  [ "$(head -c 4 "$file" | tail -c 3)" = ELF ] || continue
  checked=$((checked + 1))
  # A static or non-dynamic ELF has no dynamic symbol table; objdump then exits 1.
  version="$( (objdump -T "$file" 2>/dev/null || true) | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
  [ -n "$version" ] || continue
  echo "GLIBC_$version $file"
  newest="$(printf '%s\n%s\n' "$newest" "$version" | sort -V | tail -1)"
  if [ "$(printf '%s\n%s\n' "$max_allowed" "$version" | sort -V | tail -1)" != "$max_allowed" ]; then
    echo "error: $file needs GLIBC_$version, newer than GLIBC_$max_allowed" >&2
    failed=1
  fi
done < "$list"

[ "$checked" -gt 0 ] || { echo "error: no ELF file under $*" >&2; exit 1; }
echo "newest: GLIBC_$newest across $checked ELF files"
exit "$failed"
