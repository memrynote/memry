import { afterEach, beforeEach, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { recordsLive } from './pack-record-live'
import { snapshotsLive } from './pack-snapshot-selection'
import { updatesLive } from './pack-update-selection'

/**
 * The live-entry joins of the build and the rollup probe one index entry per
 * packed entry. With `json_each` inside, SQLite scanned the vault's rows and
 * every entry for each, about 13 s per rollup at 10k snapshots against the
 * 30 s D1 limit (#5230, collector #5247).
 */

let harness: SqliteD1
beforeEach(() => {
  harness = createSqliteD1()
})
afterEach(() => {
  harness.close()
})

const scope = { userId: 'u', vaultId: 'v' }

it.each([
  ['crdt_snapshot', snapshotsLive(scope, [{ id: 'n', sourceKey: 'k' }]), 'note_id=?'],
  ['crdt_update', updatesLive(scope, [{ sortKey: 1 }]), 'server_cursor=?'],
  ['record', recordsLive(scope, [{ sortKey: 1, sourceKey: 'k' }]), 'server_cursor=?']
])('%s: json_each is the outer loop and each entry is one index probe', (_kind, live, key) => {
  const plan = (
    harness.raw.prepare(`EXPLAIN QUERY PLAN SELECT e.key ${live.sql}`).all(...live.bind) as Array<{
      detail: string
    }>
  ).map((row) => row.detail)

  expect(plan[0]).toMatch(/^SCAN e VIRTUAL TABLE/)
  expect(plan[1]).toMatch(
    new RegExp(
      `^SEARCH s USING .*INDEX .*\\(user_id=\\? AND vault_id=\\? AND ${key.replace('?', '\\?')}\\)`
    )
  )
})
