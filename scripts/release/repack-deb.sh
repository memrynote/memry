#!/bin/sh
# Rewrites the control file of the Tauri deb so it replaces Electron's installed package, and drops
# /usr/bin/export-bindings (Tauri bundles every [[bin]] of the package; that one is a dev tool).
# Tauri names the package `memry-note` (kebab-cased productName); Electron's was `memrynote`, and
# only the same name upgrades it in place. Depends lists the runtime libraries of the Tauri app.
# Usage: repack-deb.sh <tauri.deb> <out.deb>
set -eu

in="${1:?usage: repack-deb.sh <tauri.deb> <out.deb>}"
out="${2:?usage: repack-deb.sh <tauri.deb> <out.deb>}"
depends='libwebkit2gtk-4.1-0, libgtk-3-0, libsoup-3.0-0, libayatana-appindicator3-1, libsecret-1-0, libenchant-2-2, xdg-utils'
homepage='https://github.com/memrynote/memry'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dpkg-deb -R "$in" "$work/root"
control="$work/root/DEBIAN/control"
rm -f "$work/root/usr/bin/export-bindings"

# Replace Package, Depends and Homepage with their continuation lines; add the ones Tauri left out.
awk -v depends="$depends" -v homepage="$homepage" '
  /^[^ \t]/ { skip = 0 }
  skip { next }
  /^Package:/ { print "Package: memrynote"; skip = 1; next }
  /^Depends:/ { print "Depends: " depends; skip = 1; has_depends = 1; next }
  /^Homepage:/ { print "Homepage: " homepage; skip = 1; has_homepage = 1; next }
  { print }
  END {
    if (!has_depends) print "Depends: " depends
    if (!has_homepage) print "Homepage: " homepage
  }
' "$control" > "$work/control"
mv "$work/control" "$control"

dpkg-deb -b --root-owner-group "$work/root" "$out"
dpkg-deb -f "$out" Package Version Depends Homepage
