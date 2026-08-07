/**
 * Tests for the OneNote Microsoft auth module: PKCE authorize URL, the full
 * loopback sign-in round trip (browser stubbed, token endpoint mocked), token
 * refresh + caching, status and disconnect. No live network, no real keychain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../../secrets/secret-storage', () => {
  const store = new Map<string, string>()
  return {
    __store: store,
    getSecret: vi.fn(async (service: string, account: string) => {
      return store.get(`${service}:${account}`) ?? null
    }),
    setSecret: vi.fn(async (service: string, account: string, value: string) => {
      store.set(`${service}:${account}`, value)
    }),
    deleteSecret: vi.fn(async (service: string, account: string) => {
      store.delete(`${service}:${account}`)
    })
  }
})

import { shell } from 'electron'
import * as secretStorage from '../../secrets/secret-storage'
import {
  __resetOneNoteAuthForTests,
  buildAuthorizeUrl,
  connectOneNote,
  disconnectOneNote,
  getOneNoteAccessToken,
  getOneNoteAuthStatus,
  isOneNoteConfigured,
  MS_TOKEN_URL,
  refreshAccessToken
} from './onenote-auth'

const secretStore = (secretStorage as unknown as { __store: Map<string, string> }).__store

const SERVICE = 'com.memry.import.onenote'
const ACCOUNT = '__memry_onenote__'

function seedRefreshToken(value: string): void {
  secretStore.set(`${SERVICE}:refresh-token-${ACCOUNT}`, value)
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}

describe('onenote-auth', () => {
  const originalClientId = process.env.ONENOTE_CLIENT_ID
  const originalDevice = process.env.MEMRY_DEVICE

  beforeEach(() => {
    process.env.ONENOTE_CLIENT_ID = 'client-123'
    delete process.env.MEMRY_DEVICE
    secretStore.clear()
    __resetOneNoteAuthForTests()
    vi.mocked(shell.openExternal).mockClear()
  })

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.ONENOTE_CLIENT_ID
    else process.env.ONENOTE_CLIENT_ID = originalClientId
    if (originalDevice === undefined) delete process.env.MEMRY_DEVICE
    else process.env.MEMRY_DEVICE = originalDevice
    vi.unstubAllGlobals()
    __resetOneNoteAuthForTests()
  })

  it('reports configured only when a client id is set', () => {
    expect(isOneNoteConfigured()).toBe(true)
    delete process.env.ONENOTE_CLIENT_ID
    expect(isOneNoteConfigured()).toBe(false)
  })

  it('builds a PKCE authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'http://localhost:1234',
        state: 'state-1',
        codeChallenge: 'challenge-1'
      })
    )
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    )
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('offline_access user.read notes.read')
    expect(url.searchParams.get('state')).toBe('state-1')
  })

  it('completes the loopback sign-in round trip with PKCE', async () => {
    const tokenBodies: URLSearchParams[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url)
        if (href === MS_TOKEN_URL) {
          tokenBodies.push(new URLSearchParams(String(init?.body)))
          return new Response(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (href === 'https://graph.microsoft.com/v1.0/me') {
          return new Response(JSON.stringify({ displayName: 'Kaan', mail: 'kaan@example.com' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        throw new Error(`unexpected fetch ${href}`)
      })
    )

    const connectPromise = connectOneNote()

    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalled()
    })
    const authUrl = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
    const redirectUri = authUrl.searchParams.get('redirect_uri')!
    const state = authUrl.searchParams.get('state')!
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/)

    const callback = await httpGet(`${redirectUri}/?code=auth-code-1&state=${state}`)
    expect(callback.status).toBe(200)
    expect(callback.body).toContain('OneNote connected')

    const account = await connectPromise
    expect(account).toEqual({ name: 'Kaan', email: 'kaan@example.com' })

    // The code exchange carried the PKCE verifier matching the challenge.
    expect(tokenBodies).toHaveLength(1)
    expect(tokenBodies[0].get('grant_type')).toBe('authorization_code')
    expect(tokenBodies[0].get('code')).toBe('auth-code-1')
    expect(tokenBodies[0].get('code_verifier')).toBeTruthy()

    // Tokens + profile persisted in secret storage.
    expect(secretStore.get(`${SERVICE}:refresh-token-${ACCOUNT}`)).toBe('refresh-1')
    expect(secretStore.get(`${SERVICE}:access-token-${ACCOUNT}`)).toBe('access-1')
    expect(secretStore.get(`${SERVICE}:profile-${ACCOUNT}`)).toContain('kaan@example.com')

    const status = await getOneNoteAuthStatus()
    expect(status).toEqual({
      configured: true,
      connected: true,
      account: { name: 'Kaan', email: 'kaan@example.com' }
    })
  })

  it('ignores unrelated requests to the loopback port instead of aborting sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url)
        if (href === MS_TOKEN_URL) {
          return new Response(
            JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response(JSON.stringify({ displayName: 'K', mail: 'k@e.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
        void init
      })
    )

    const connectPromise = connectOneNote()
    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalled()
    })
    const authUrl = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
    const redirectUri = authUrl.searchParams.get('redirect_uri')!
    const state = authUrl.searchParams.get('state')!

    // A stray probe (scanner, prefetch) must not tear the flow down.
    const probe = await httpGet(`${redirectUri}/favicon.ico`)
    expect(probe.status).toBe(404)

    const callback = await httpGet(`${redirectUri}/?code=real-code&state=${state}`)
    expect(callback.status).toBe(200)
    await expect(connectPromise).resolves.toEqual({ name: 'K', email: 'k@e.com' })
  })

  it('settles the first sign-in when a second one supersedes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    )

    const first = connectOneNote()
    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalledTimes(1)
    })
    const firstRejects = expect(first).rejects.toThrow(/restarted/i)

    const second = connectOneNote()
    await firstRejects
    // Wait until the second flow is actually listening before tearing it down.
    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalledTimes(2)
    })

    // Leave no server listening (and no pending promise) behind either flow.
    const secondRejects = expect(second).rejects.toThrow(/cancelled/i)
    __resetOneNoteAuthForTests()
    await secondRejects
  })

  it('still connects when the profile lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === MS_TOKEN_URL) {
          return new Response(
            JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('boom', { status: 503 })
      })
    )

    const connectPromise = connectOneNote()
    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalled()
    })
    const authUrl = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
    const redirectUri = authUrl.searchParams.get('redirect_uri')!
    const state = authUrl.searchParams.get('state')!
    await httpGet(`${redirectUri}/?code=c&state=${state}`)

    await expect(connectPromise).resolves.toEqual({ name: '', email: '' })
    const status = await getOneNoteAuthStatus()
    expect(status.connected).toBe(true)
  })

  it('rejects a callback carrying the wrong state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('token endpoint must not be called')
      })
    )
    const connectPromise = connectOneNote()
    await vi.waitFor(() => {
      expect(shell.openExternal).toHaveBeenCalled()
    })
    const authUrl = new URL(vi.mocked(shell.openExternal).mock.calls[0][0])
    const redirectUri = authUrl.searchParams.get('redirect_uri')!

    const callback = await httpGet(`${redirectUri}/?code=auth-code&state=wrong-state`)
    expect(callback.status).toBe(400)
    await expect(connectPromise).rejects.toThrow(/state/i)
  })

  it('refreshes from the stored refresh token and keeps rotation', async () => {
    seedRefreshToken('refresh-old')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe(MS_TOKEN_URL)
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toBe('refresh-old')
        return new Response(
          JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-new' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      })
    )
    const token = await refreshAccessToken({ clientId: 'client-123' })
    expect(token).toBe('access-2')
    expect(secretStore.get(`${SERVICE}:refresh-token-${ACCOUNT}`)).toBe('refresh-new')
  })

  it('serves a cached access token until forced to refresh', async () => {
    seedRefreshToken('refresh-1')
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: `access-${fetchMock.mock.calls.length}`, expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = await getOneNoteAccessToken({ clientId: 'client-123' })
    const second = await getOneNoteAccessToken({ clientId: 'client-123' })
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await getOneNoteAccessToken({ clientId: 'client-123', forceRefresh: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('errors clearly when refreshing without a stored token', async () => {
    await expect(refreshAccessToken({ clientId: 'client-123' })).rejects.toThrow(/not connected/i)
  })

  it('disconnect wipes tokens and profile', async () => {
    seedRefreshToken('refresh-1')
    secretStore.set(`${SERVICE}:profile-${ACCOUNT}`, '{"name":"K","email":"k@e.com"}')
    await disconnectOneNote()
    expect(secretStore.size).toBe(0)
    const status = await getOneNoteAuthStatus()
    expect(status.connected).toBe(false)
  })
})
