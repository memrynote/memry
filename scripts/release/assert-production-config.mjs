#!/usr/bin/env node
// Production configuration guards of a release build.
//   pre                 before the build: SYNC_SERVER_URL is the production sync origin
//                       (PRODUCTION_SYNC_URL in crates/memry-desktop/src/config.rs)
//   post <payload-dir>  after the build: the executables of the payload carry the production sync
//                       URL and update feed, and no staging sync URL or rehearsal feed
// `build_env.rs` already refuses a production release build without the required values or with a
// rehearsal feed; these checks add the URL shape and a look at the bytes that ship.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isMain } from './is-main.mjs'

export const PRODUCTION_FEED = 'https://github.com/memrynote/memry'

/**
 * Strings no production executable may hold. Not `localhost` or a bare `sync-staging`: every build
 * carries `http://localhost:8787` (the development default, `memry-desktop/src/config.rs`), the
 * `*.localhost` IPC origins and the `sync-staging.memrynote.com` TLS pin, so a localhost sync URL is
 * caught only by the `pre` check of `SYNC_SERVER_URL`.
 */
export const FORBIDDEN = ['://sync-staging', 'memry-update-rehearsal']

/**
 * The production sync origin, read from `PRODUCTION_SYNC_URL` in memry-desktop's config.rs, which
 * owns it.
 */
export const PRODUCTION_SYNC_ORIGIN = (() => {
  const configRs = path.join(import.meta.dirname, '../../crates/memry-desktop/src/config.rs')
  const match = /pub const PRODUCTION_SYNC_URL: &str = "([^"]+)";/.exec(
    readFileSync(configRs, 'utf8')
  )
  if (!match) throw new Error(`no PRODUCTION_SYNC_URL in ${configRs}`)
  return new URL(match[1]).origin
})()

/**
 * `assertProductionSyncServerUrl` of `apps/desktop/scripts/build-packaged-app-utils.cjs`, with an
 * allowlist: the URL must be `PRODUCTION_SYNC_ORIGIN`, not merely not local or staging. The app
 * uses the trimmed value with a trailing `/` stripped as its sync base (`RuntimeConfig::resolve`),
 * so a port, path, credentials, query or fragment would reach every sync request.
 */
export function assertProductionSyncServerUrl(syncServerUrl) {
  const value = syncServerUrl?.trim()
  if (!value) {
    throw new Error('production SYNC_SERVER_URL must be configured')
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('production SYNC_SERVER_URL must be a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('production SYNC_SERVER_URL must use HTTPS')
  }

  if (
    parsed.origin !== PRODUCTION_SYNC_ORIGIN ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `production SYNC_SERVER_URL must be ${PRODUCTION_SYNC_ORIGIN}, the production sync host, with no port, path, credentials, query or fragment`
    )
  }
  return value
}

const MAGICS = [
  [0x4d, 0x5a], // PE: MZ
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
  [0xca, 0xfe, 0xba, 0xbe] // Mach-O universal
]

const isExecutable = (bytes) => MAGICS.some((magic) => magic.every((b, i) => bytes[i] === b))

function* executables(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* executables(file)
    else if (entry.isFile()) {
      const bytes = readFileSync(file)
      if (isExecutable(bytes)) yield { file, bytes }
    }
  }
}

/**
 * Problems of the payload under `dir`: a `FORBIDDEN` string in any executable, and `syncServerUrl`
 * or the production feed in none. The presence checks also prove the scan read the real strings.
 */
export function scanPayload(dir, syncServerUrl) {
  const problems = []
  const required = new Map([syncServerUrl, PRODUCTION_FEED].map((text) => [text, false]))
  let count = 0
  for (const { file, bytes } of executables(dir)) {
    count += 1
    for (const text of FORBIDDEN) {
      if (bytes.includes(text)) problems.push(`${path.relative(dir, file)} contains "${text}"`)
    }
    for (const text of required.keys()) {
      if (bytes.includes(text)) required.set(text, true)
    }
  }
  if (count === 0) return [`no executable under ${dir}`]
  for (const [text, found] of required) {
    if (!found) problems.push(`no executable contains "${text}"`)
  }
  return problems
}

if (isMain(import.meta)) {
  const [mode, dir] = process.argv.slice(2)
  try {
    const syncServerUrl = assertProductionSyncServerUrl(process.env.SYNC_SERVER_URL)
    if (mode === 'post' && dir) {
      const problems = scanPayload(dir, syncServerUrl)
      if (problems.length > 0) throw new Error(problems.join('\n'))
    } else if (mode !== 'pre') {
      throw new Error('usage: assert-production-config.mjs pre | post <payload-dir>')
    }
    console.log(`production config ok (${mode})`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
