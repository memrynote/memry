/**
 * Regression cover for the "Connect can never recover" deadlock.
 *
 * An install that ran v2026-08-06 wrote its Google tokens under the short-lived
 * `memrynote` safeStorage key; app-identity.ts then pinned the profile back to
 * the legacy name, so those ciphertexts are undecryptable forever and keytar has
 * no copy left. getSecret's #772 guard then THROWS rather than reporting the
 * secret as absent — and connectGoogleCalendar reads the existing tokens BEFORE
 * it stores the fresh ones, so the throw killed the flow before the write. Every
 * retry hit the same wall, with no path back from inside the app.
 *
 * These tests drive the real oauth.ts + keychain.ts + secret-storage.ts against
 * a real on-disk store seeded with an undecryptable entry.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'

const harness = vi.hoisted(() => ({
  userDataDir: '',
  keytarStore: new Map<string, string>()
}))

const mockOpenExternal = vi.fn()

vi.mock('electron', () => ({
  shell: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args)
  },
  app: {
    isReady: () => true,
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return harness.userDataDir
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain_access',
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf-8')
      // Anything not written under the current identity fails to decrypt, which
      // is exactly what Chromium's OSCrypt does with a foreign key.
      if (!raw.startsWith('enc:')) throw new Error('safeStorage decrypt failed')
      return raw.slice('enc:'.length)
    }
  }
}))

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

vi.mock('../repositories/calendar-sources-repository', () => ({
  listCalendarSources: vi.fn(() => [])
}))

vi.mock('../../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasGoogleCalendarLocalAuth
} from './oauth'
import { getGoogleCalendarTokens, hasGoogleCalendarTokens } from './keychain'
import { SECRET_STORE_FILENAME, resetSecretStorageForTests } from '../../secrets/secret-storage'

const SERVICE = 'com.memry.calendar.google'
const ACCOUNT_ID = 'user@example.com'

const storeFilePath = (): string => path.join(harness.userDataDir, SECRET_STORE_FILENAME)

const readStore = (): { entries: Record<string, Record<string, string>> } =>
  JSON.parse(fs.readFileSync(storeFilePath(), 'utf-8'))

/** Ciphertext this run's identity cannot decrypt — the poisoned v2026-08-06 entry. */
const poisoned = (value: string): string =>
  Buffer.from(`foreign-key:${value}`, 'utf-8').toString('base64')

const seedPoisonedTokens = (): void => {
  fs.mkdirSync(harness.userDataDir, { recursive: true })
  fs.writeFileSync(
    storeFilePath(),
    JSON.stringify({
      version: 1,
      entries: {
        [SERVICE]: {
          [`access-token-${ACCOUNT_ID}`]: poisoned('dead-access'),
          [`refresh-token-${ACCOUNT_ID}`]: poisoned('dead-refresh')
        }
      }
    }),
    'utf-8'
  )
}

const stubGoogleEndpoints = (): void => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          scope: 'openid email profile https://www.googleapis.com/auth/calendar',
          token_type: 'Bearer'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      return new Response(
        JSON.stringify({ email: ACCOUNT_ID, verified_email: true, name: 'User Example' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
      return new Response(
        JSON.stringify({
          id: ACCOUNT_ID,
          summary: 'User Example',
          timeZone: 'Europe/Istanbul',
          primary: true
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (url === 'https://oauth2.googleapis.com/revoke') {
      return new Response('', { status: 200 })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  mockOpenExternal.mockImplementation(async (authUrl: string) => {
    const parsed = new URL(authUrl)
    const state = parsed.searchParams.get('state')
    const redirectUri = parsed.searchParams.get('redirect_uri')
    setTimeout(() => {
      http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
    }, 0)
  })
}

describe('google calendar OAuth with an undecryptable stored token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSecretStorageForTests()
    harness.keytarStore.clear()
    harness.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-google-poisoned-'))
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'google-client-id-123'
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    delete process.env.MEMRY_DEVICE

    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      harness.keytarStore.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => harness.keytarStore.get(`${service}:${account}`) ?? null
    )
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
      harness.keytarStore.delete(`${service}:${account}`)
    )

    seedPoisonedTokens()
  })

  afterEach(() => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID
    vi.unstubAllGlobals()
    fs.rmSync(harness.userDataDir, { recursive: true, force: true })
  })

  it('completes the connect flow and persists the fresh tokens over the poisoned ones', async () => {
    stubGoogleEndpoints()

    const result = await connectGoogleCalendar()

    expect(result.accountId).toBe(ACCOUNT_ID)
    // The whole point: the write at the end of the flow was reached.
    expect(await getGoogleCalendarTokens(ACCOUNT_ID)).toEqual({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token'
    })
    // And the undecryptable bytes are gone from disk, not merely shadowed.
    const entries = readStore().entries[SERVICE]
    expect(entries[`access-token-${ACCOUNT_ID}`]).not.toBe(poisoned('dead-access'))
    expect(entries[`refresh-token-${ACCOUNT_ID}`]).not.toBe(poisoned('dead-refresh'))
  })

  it('reports the account as needing reconnect instead of throwing at status read', async () => {
    await expect(hasGoogleCalendarTokens(ACCOUNT_ID)).resolves.toBe(false)
    await expect(hasGoogleCalendarLocalAuth(ACCOUNT_ID)).resolves.toBe(false)
    await expect(getGoogleCalendarTokens(ACCOUNT_ID)).resolves.toEqual({
      accessToken: null,
      refreshToken: null
    })
  })

  it('disconnect clears the poisoned entries instead of throwing', async () => {
    stubGoogleEndpoints()

    await expect(disconnectGoogleCalendar(ACCOUNT_ID)).resolves.toBeUndefined()

    expect(readStore().entries[SERVICE]).toBeUndefined()
  })
})
