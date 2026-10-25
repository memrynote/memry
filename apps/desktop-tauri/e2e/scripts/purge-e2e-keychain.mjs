#!/usr/bin/env node
// One-shot purge of the keychain items e2e runs left behind. Dry run by default; `--apply`
// deletes. macOS scans `security dump-keychain`, Windows `cmdkey /list`, Linux
// `secret-tool search`; the parsers and the denylist of production and dev accounts are the
// ones the harness teardown uses (`../harness/keychain-cleanup.mjs`).
//
//   node e2e/scripts/purge-e2e-keychain.mjs
//   node e2e/scripts/purge-e2e-keychain.mjs --apply
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  PROTECTED_ACCOUNTS,
  SYNC_SERVICE,
  isPurgeableE2eEntry,
  parseCmdkeyList,
  parseKeychainDump,
  parseSecretToolSearch
} from '../harness/keychain-cleanup.mjs'

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  return result.stdout ?? ''
}

function status(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 }).status
}

/** Everything this OS holds, as `{ service, account, remove() }`. */
export function listEntries(platform = process.platform) {
  if (platform === 'darwin') {
    return parseKeychainDump(capture('security', ['dump-keychain'])).map((entry) => ({
      ...entry,
      // `security` removes one item per call; duplicates need a loop.
      remove: () => {
        let removed = 0
        while (
          status('security', [
            'delete-generic-password',
            '-s',
            entry.service,
            '-a',
            entry.account
          ]) === 0
        ) {
          removed++
        }
        return removed
      }
    }))
  }
  if (platform === 'win32') {
    return parseCmdkeyList(capture('cmdkey', ['/list'])).map((target) => {
      // Targets read `<account>.<service>` for the sync service.
      const service = target.includes(SYNC_SERVICE) ? SYNC_SERVICE : undefined
      const account = service ? target.slice(0, target.indexOf(`.${SYNC_SERVICE}`)) : undefined
      return {
        service,
        account,
        remove: () => (status('cmdkey', [`/delete:${target}`]) === 0 ? 1 : 0)
      }
    })
  }
  if (platform === 'linux') {
    return parseSecretToolSearch(
      capture('secret-tool', ['search', '--all', 'service', SYNC_SERVICE])
    ).map((entry) => ({
      ...entry,
      remove: () =>
        status('secret-tool', ['clear', 'service', SYNC_SERVICE, 'username', entry.account]) === 0
          ? 1
          : 0
    }))
  }
  return []
}

function main() {
  const apply = process.argv.includes('--apply')
  const all = listEntries()
  const targets = all.filter(isPurgeableE2eEntry)
  console.log(`Scanned ${all.length} keychain items.`)
  console.log(
    `  ${SYNC_SERVICE} items:        ${all.filter((e) => e.service === SYNC_SERVICE).length}`
  )
  console.log(`  e2e items to purge:          ${targets.length}`)
  console.log(`  kept (dev/prod/unrelated):   ${all.length - targets.length}`)
  for (const t of targets.slice(0, 5)) console.log(`  ${t.service}  ${t.account}`)
  if (targets.length > 5) console.log(`  ... and ${targets.length - 5} more`)

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to delete.')
    return
  }
  let deleted = 0
  for (const target of targets) {
    if (PROTECTED_ACCOUNTS.has(target.account)) {
      throw new Error(`Refusing to delete protected account: ${target.account}`)
    }
    deleted += target.remove()
  }
  console.log(`\nDeleted ${deleted} items.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
