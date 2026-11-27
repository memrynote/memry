#!/usr/bin/env node
// Writes the Tauri config overlay that stamps the release version, for `tauri build --config`.
// tauri.conf.json keeps `0.0.0`; without the overlay a packaged build reports 0.0.0 in the log
// header, telemetry, About and Settings, while Velopack's sq.version holds the real version.
// Usage: node scripts/release/version-config.mjs <version> <out.json>
import { writeFileSync } from 'node:fs'

import { isMain } from './is-main.mjs'

/**
 * `{ version }` for a release version. Tauri needs semver, and Windows puts each part in a 16-bit
 * field of the exe's version resource, so `YYYY.MDD.n` and `2099.101.n` pass and nothing else. A
 * `0.x` version is the unstamped default: the sync server's desktop write floor rejects it.
 */
export function versionConfig(version) {
  const parts = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '')
  if (!parts || parts.slice(1).some((part) => Number(part) > 65535)) {
    throw new Error(`"${version}" is not a release version such as 2026.1025.1`)
  }
  return { version }
}

if (isMain(import.meta)) {
  const [version, out] = process.argv.slice(2)
  if (!out) {
    console.error('usage: version-config.mjs <version> <out.json>')
    process.exit(2)
  }
  writeFileSync(out, `${JSON.stringify(versionConfig(version))}\n`)
}
