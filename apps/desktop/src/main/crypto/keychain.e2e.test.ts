import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import type { KeychainEntry } from '@memry/contracts/crypto'

import { deleteKey, retrieveKey, storeKey } from './keychain'

const e2e = process.env.KEYCHAIN_E2E === '1'

const TEST_ENTRY: KeychainEntry = {
  service: 'com.memry.sync.test',
  account: `keychain-e2e-${process.pid}-${Date.now()}`
}

describe.skipIf(!e2e)('keychain E2E against real OS keychain', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  afterAll(async () => {
    // #cleanup — best-effort delete in case a test failed mid-roundtrip
    try {
      await deleteKey(TEST_ENTRY)
    } catch {
      // entry may already be gone; ignore
    }
  })

  it('roundtrips: store → retrieve → delete → retrieve returns null', async () => {
    // #given
    const key = sodium.randombytes_buf(32)

    // #when — store
    await storeKey(TEST_ENTRY, key)

    // #then — retrieve returns the same bytes
    const retrieved = await retrieveKey(TEST_ENTRY)
    expect(retrieved).toEqual(key)

    // #when — delete
    await deleteKey(TEST_ENTRY)

    // #then — subsequent retrieve returns null
    const afterDelete = await retrieveKey(TEST_ENTRY)
    expect(afterDelete).toBeNull()
  })
})
