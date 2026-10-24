import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodiumModule from 'libsodium-wrappers-sumo'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database/types'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({ getDatabase: () => currentDb }))
vi.mock('../vault', () => ({ getStatus: () => ({ path: '/vaults/a' }) }))

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (service: string, account: string, value: string) => {
    secrets.set(`${service}/${account}`, value)
  }),
  getSecret: vi.fn(
    async (service: string, account: string) => secrets.get(`${service}/${account}`) ?? null
  ),
  deleteSecret: vi.fn(async (service: string, account: string) => {
    secrets.delete(`${service}/${account}`)
  })
}))

import { connectReadwise, disconnectReadwise, getReadwiseStatus } from './connection'
import { getCursor, setCursor } from './sync-state'

// Default import kept: tests mock this module with a default-only factory.
const sodium = sodiumModule

beforeAll(async () => {
  await sodium.ready
})

const TOKEN = 'tok-secret-123'

function stubAuth(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(null, { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('readwise connection', () => {
  let result: TestDatabaseResult

  beforeEach(() => {
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
  })

  it('verifies the token against Readwise before storing it, then reports connected', async () => {
    const fetchMock = stubAuth(204)

    const status = await connectReadwise(`  ${TOKEN} `)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://readwise.io/api/v2/auth/')
    expect(status.connected).toBe(true)
    expect([...secrets.values()]).toEqual([TOKEN])
  })

  it('rejects an invalid token with a readable message and stores nothing', async () => {
    stubAuth(401)

    await expect(connectReadwise(TOKEN)).rejects.toThrow(/did not accept this token/)

    expect(secrets.size).toBe(0)
    expect((await getReadwiseStatus()).connected).toBe(false)
  })

  it('reports an unreachable Readwise without storing the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await expect(connectReadwise(TOKEN)).rejects.toThrow(/Could not reach Readwise/)
    expect(secrets.size).toBe(0)
  })

  it('never carries the token in the status it returns', async () => {
    stubAuth(204)
    const status = await connectReadwise(TOKEN)
    expect(JSON.stringify(status)).not.toContain(TOKEN)
  })

  it('disconnects by deleting the token and run state, and can reconnect', async () => {
    stubAuth(204)
    await connectReadwise(TOKEN)
    setCursor(currentDb!, '2026-10-22T10:00:00.000Z')

    await disconnectReadwise()

    expect(secrets.size).toBe(0)
    expect(getCursor(currentDb!)).toBeNull()
    expect((await getReadwiseStatus()).connected).toBe(false)

    await connectReadwise(TOKEN)
    expect((await getReadwiseStatus()).connected).toBe(true)
  })
})
