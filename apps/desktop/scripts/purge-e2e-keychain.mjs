#!/usr/bin/env node
/**
 * One-shot purge of the macOS keychain backlog left by E2E runs.
 *
 * Every `pnpm test:e2e` launch sets `MEMRY_DEVICE=e2e-<uuid>-A|B`, which suffixes
 * every KEYCHAIN_ENTRIES account (see main/crypto/keychain-account.ts). Until the
 * harness learned to clean up after itself (tests/e2e/utils/keychain-cleanup.ts)
 * those items were never deleted, so a machine that has run the suite for a while
 * accumulates thousands of `com.memry.sync` rows. This reclaims them.
 *
 * Dry-run by default. Pass `--apply` to actually delete.
 *
 *   node scripts/purge-e2e-keychain.mjs
 *   node scripts/purge-e2e-keychain.mjs --apply
 */

import { spawnSync } from 'node:child_process'

const SYNC_SERVICE = 'com.memry.sync'

/**
 * Accounts that must NEVER be deleted: production (bare), the shared plain-dev
 * account, and the explicit local dev devices. Belt-and-braces — none of these
 * contain `-e2e-`, so the matcher already rejects them, but an exact denylist
 * means a future matcher bug still cannot nuke a developer's real master key.
 */
const PROTECTED_ACCOUNTS = new Set([
  'master-key',
  'master-key-dev',
  'master-key-A',
  'master-key-B',
  'master-key-C',
  'device-signing-key',
  'device-signing-key-dev',
  'device-signing-key-A',
  'device-signing-key-B',
  'device-signing-key-C',
  'access-token',
  'refresh-token',
  'setup-token',
  'pairing-token'
])

/** `master-key-e2e-<uuid>-A`, `setup-token-e2e-vault-deletion-<uuid>`, ... */
const E2E_SYNC_ACCOUNT = /^[a-z-]+-e2e-[A-Za-z0-9@._-]+$/

/** Electron safeStorage: service is `<app.name> Safe Storage`, app.name is `memry-<MEMRY_DEVICE>`. */
const E2E_SAFE_STORAGE_SERVICE = /^memry-e2e-[A-Za-z0-9-]+ Safe Storage$/

export function isPurgeableE2eEntry(entry) {
  const { service, account } = entry
  if (!service || !account) return false
  if (PROTECTED_ACCOUNTS.has(account)) return false

  if (service === SYNC_SERVICE) {
    return account.includes('-e2e-') && E2E_SYNC_ACCOUNT.test(account)
  }
  return E2E_SAFE_STORAGE_SERVICE.test(service)
}

/**
 * Parse `security dump-keychain` output into {service, account} pairs.
 * Attribute values are quoted blobs, optionally preceded by a hex dump for
 * non-ASCII values, or the literal `<NULL>`.
 */
export function parseKeychainDump(text) {
  const attr = /^\s*"(acct|svce)"<blob>=(?:0x[0-9A-Fa-f]+\s+)?(?:"((?:[^"\\]|\\.)*)"|<NULL>)\s*$/
  const entries = []
  let current = {}

  const flush = () => {
    if (current.acct !== undefined || current.svce !== undefined) {
      entries.push({ service: current.svce, account: current.acct })
    }
    current = {}
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('keychain:')) {
      flush()
      continue
    }
    const match = attr.exec(line)
    if (match) current[match[1]] = match[2]
  }
  flush()

  return entries
}

function dumpKeychain() {
  const result = spawnSync('security', ['dump-keychain'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  if (result.error) throw result.error
  return result.stdout ?? ''
}

function deleteGenericPassword(service, account) {
  return spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], {
    stdio: 'ignore',
    timeout: 10_000
  }).status
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('Not macOS — nothing to do (no `security` keychain).')
    return
  }

  const apply = process.argv.includes('--apply')
  const all = parseKeychainDump(dumpKeychain())
  const targets = all.filter(isPurgeableE2eEntry)

  const memryBefore = all.filter((e) => e.service === SYNC_SERVICE).length
  console.log(`Scanned ${all.length} keychain items.`)
  console.log(`  ${SYNC_SERVICE} items:        ${memryBefore}`)
  console.log(`  e2e items to purge:          ${targets.length}`)
  console.log(`  kept (dev/prod/unrelated):   ${all.length - targets.length}`)

  const sample = targets.slice(0, 5)
  if (sample.length) {
    console.log('\nSample targets:')
    for (const t of sample) console.log(`  ${t.service}  ${t.account}`)
    if (targets.length > sample.length)
      console.log(`  ... and ${targets.length - sample.length} more`)
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to delete.')
    return
  }

  let deleted = 0
  let failed = 0
  for (const { service, account } of targets) {
    if (PROTECTED_ACCOUNTS.has(account)) {
      throw new Error(`Refusing to delete protected account: ${account}`)
    }
    // `security` removes one item per call; duplicates need a loop.
    let status = deleteGenericPassword(service, account)
    if (status === 0) {
      deleted++
      while (deleteGenericPassword(service, account) === 0) deleted++
    } else {
      failed++
    }
  }

  const after = parseKeychainDump(dumpKeychain())
  console.log(`\nDeleted ${deleted} items (${failed} could not be deleted).`)
  console.log(
    `  ${SYNC_SERVICE} items:        ${memryBefore} -> ${after.filter((e) => e.service === SYNC_SERVICE).length}`
  )
  console.log(`  remaining e2e items:         ${after.filter(isPurgeableE2eEntry).length}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
