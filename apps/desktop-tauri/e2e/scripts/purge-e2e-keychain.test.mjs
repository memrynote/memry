import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isPurgeableE2eEntry } from '../harness/keychain-cleanup.mjs'

const SYNC = 'com.memry.sync'

// The cases of apps/desktop/scripts/purge-e2e-keychain.test.mjs that decide what `--apply`
// may delete: only `-e2e-` accounts of the sync service, never a production or dev account.
test('apply targets e2e accounts and never production or dev accounts', () => {
  const entries = [
    { service: SYNC, account: 'master-key-e2e-1-A' },
    { service: SYNC, account: 'master-key' },
    { service: SYNC, account: 'master-key-dev-d9cfd05c' },
    { service: SYNC, account: 'pairing-token' },
    { service: 'memry-e2e-1-A Safe Storage', account: 'memry-e2e-1-A Key' },
    { service: 'memry-A Safe Storage', account: 'memry-A Key' }
  ]
  assert.deepEqual(
    entries.filter(isPurgeableE2eEntry).map((entry) => entry.account),
    ['master-key-e2e-1-A', 'memry-e2e-1-A Key']
  )
})
