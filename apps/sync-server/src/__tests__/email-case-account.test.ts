import { timingSafeEqual } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { storeOtp, verifyOtp } from '../services/otp'
import { getOrCreateUserByEmail } from '../services/user'

/**
 * One inbox, one account. A user signed in on iOS as "Name@x.com" and on
 * macOS as "name@x.com" got two accounts, so the Mac's vault never reached
 * the phone. Email case must not split an account.
 */

const HMAC_KEY = 'test-otp-hmac-key'

let harness: SqliteD1

const insertLegacyUser = (id: string, email: string, createdAt: number): void => {
  harness.raw
    .prepare(
      "INSERT INTO users (id, email, auth_method, created_at, updated_at) VALUES (?, ?, 'otp', ?, ?)"
    )
    .run(id, email, createdAt, createdAt)
}

const signIn = async (email: string) =>
  (await getOrCreateUserByEmail(harness.db, email, { authMethod: 'otp' })).user

// crypto.subtle.timingSafeEqual is a Workers API that Node lacks.
beforeAll(() => {
  if (!crypto.subtle.timingSafeEqual) {
    Object.assign(crypto.subtle, {
      timingSafeEqual: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b)
    })
  }
})

beforeEach(() => {
  harness = createSqliteD1()
})

afterEach(() => {
  harness.close()
})

describe('email case and accounts', () => {
  it('signs differently cased addresses into one account', async () => {
    const phone = await signIn(' Name@Example.com')
    const mac = await signIn('name@example.com')

    expect(mac.id).toBe(phone.id)
    expect(phone.email).toBe('name@example.com')
  })

  it('finds an account stored with uppercase letters before normalization', async () => {
    insertLegacyUser('legacy', 'Name@Example.com', 1_700_000_000)

    const { user, isNewUser } = await getOrCreateUserByEmail(harness.db, 'name@example.com', {
      authMethod: 'otp'
    })

    expect(isNewUser).toBe(false)
    expect(user.id).toBe('legacy')
  })

  it('resolves an address already split by case to its lowercase account', async () => {
    insertLegacyUser('cased', 'Name@Example.com', 1_700_000_000)
    insertLegacyUser('lower', 'name@example.com', 1_700_000_100)

    expect((await signIn('NAME@example.com')).id).toBe('lower')
    expect((await signIn('Name@Example.com')).id).toBe('lower')
  })

  it('accepts a code requested with one case and verified with another', async () => {
    await storeOtp(harness.db, 'Name@Example.com', '123456', HMAC_KEY)

    await expect(verifyOtp(harness.db, 'name@example.com', '123456', HMAC_KEY)).resolves.toBe(
      undefined
    )
  })
})
