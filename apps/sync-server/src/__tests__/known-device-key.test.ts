import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { isActiveDeviceKey } from '../services/device'

/**
 * #2612: a device that still holds its keys signs back in with the email code
 * alone, but only while the account still lists it. A revoked device must go
 * through the recovery phrase again.
 */

let harness: SqliteD1

const addUser = (id: string): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, kdf_salt, key_verifier, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 'salt', 'verifier', 1, 1)`
    )
    .run(id, `${id}@example.com`)
}

const addDevice = (id: string, userId: string, publicKey: string, revokedAt: number | null) => {
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, revoked_at, created_at, updated_at)
       VALUES (?, ?, 'Laptop', 'windows', '1.0.0', ?, ?, 1, 1)`
    )
    .run(id, userId, publicKey, revokedAt)
}

beforeEach(() => {
  harness = createSqliteD1()
  addUser('user-a')
  addUser('user-b')
  addDevice('device-active', 'user-a', 'key-active', null)
  addDevice('device-revoked', 'user-a', 'key-revoked', 1_790_000_000)
  addDevice('device-other', 'user-b', 'key-other', null)
})

afterEach(() => {
  harness.close()
})

describe('isActiveDeviceKey (#2612)', () => {
  it('knows an unrevoked device of the account by its signing key', async () => {
    await expect(isActiveDeviceKey(harness.db, 'user-a', 'key-active')).resolves.toBe(true)
  })

  it('does not know a revoked device', async () => {
    await expect(isActiveDeviceKey(harness.db, 'user-a', 'key-revoked')).resolves.toBe(false)
  })

  it('does not know a device of another account', async () => {
    await expect(isActiveDeviceKey(harness.db, 'user-a', 'key-other')).resolves.toBe(false)
  })

  it('does not know a sign-in that sent no key', async () => {
    await expect(isActiveDeviceKey(harness.db, 'user-a', undefined)).resolves.toBe(false)
  })
})
