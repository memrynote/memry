import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { mockApp, mockElectron } from '@tests/utils/mock-electron'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { ReadwiseImportChannels } from '@memry/contracts/import-channels'
import type { DataDb } from '../database/types'

vi.mock('electron', () => ({ app: mockApp, ipcMain: mockElectron.ipcMain }))

let currentDb: DataDb | null = null
vi.mock('../database', () => ({ getDatabase: () => currentDb }))
vi.mock('../vault', () => ({ getStatus: () => ({ path: '/vaults/a' }) }))

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}/${a}`, v)),
  getSecret: vi.fn(async (s: string, a: string) => secrets.get(`${s}/${a}`) ?? null),
  deleteSecret: vi.fn(async (s: string, a: string) => void secrets.delete(`${s}/${a}`))
}))

import {
  registerReadwiseImportHandlers,
  unregisterReadwiseImportHandlers
} from './readwise-import-handlers'

type Handler = (event: unknown, input?: unknown) => Promise<Record<string, unknown>>

function handlerFor(channel: string): Handler {
  const call = mockElectron.ipcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`no handler for ${channel}`)
  return call[1] as Handler
}

const TOKEN = 'tok-secret-xyz'

beforeAll(async () => {
  await sodium.ready
})

describe('readwise import IPC handlers', () => {
  let result: TestDatabaseResult

  beforeEach(() => {
    vi.clearAllMocks()
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
    registerReadwiseImportHandlers()
  })
  afterEach(() => {
    unregisterReadwiseImportHandlers()
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
  })

  it('registers all five channels and removes them again', () => {
    for (const channel of Object.values(ReadwiseImportChannels.invoke)) handlerFor(channel)
    unregisterReadwiseImportHandlers()
    for (const channel of Object.values(ReadwiseImportChannels.invoke)) {
      expect(mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('status reports disconnected with defaults on a fresh vault', async () => {
    const status = await handlerFor(ReadwiseImportChannels.invoke.STATUS)({}, undefined)
    expect(status).toMatchObject({ connected: false, hasImported: false, syncNowAvailable: false })
    expect((status.options as { rootFolder: string }).rootFolder).toBe('Readwise')
  })

  it('connect verifies the token, stores it, and never echoes it back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    const status = await handlerFor(ReadwiseImportChannels.invoke.CONNECT)(
      {},
      { token: ` ${TOKEN} ` }
    )
    expect(status.connected).toBe(true)
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect([...secrets.values()]).toEqual([TOKEN])
  })

  it('connect with an invalid token answers a failure envelope and stores nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    )
    const res = await handlerFor(ReadwiseImportChannels.invoke.CONNECT)({}, { token: TOKEN })
    expect(res).toMatchObject({ success: false })
    expect(String(res.error)).toMatch(/did not accept this token/)
    expect(secrets.size).toBe(0)
  })

  it('connect rejects an empty token at the schema', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      handlerFor(ReadwiseImportChannels.invoke.CONNECT)({}, { token: '   ' })
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('set-options persists, returns the new status, and rejects a path escape', async () => {
    const set = handlerFor(ReadwiseImportChannels.invoke.SET_OPTIONS)
    const status = await set(
      {},
      { folderLayout: 'flat', categories: { supplementals: true }, rootFolder: '/Reading/' }
    )
    expect(status.options).toMatchObject({
      folderLayout: 'flat',
      rootFolder: 'Reading',
      categories: { supplementals: true, books: true }
    })
    await expect(set({}, { rootFolder: '../outside' })).rejects.toThrow()
  })

  it('disconnect deletes the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    await handlerFor(ReadwiseImportChannels.invoke.CONNECT)({}, { token: TOKEN })
    const res = await handlerFor(ReadwiseImportChannels.invoke.DISCONNECT)({}, undefined)
    expect(res).toEqual({ success: true })
    expect(secrets.size).toBe(0)
  })

  it('sync-now answers a failure envelope until the run engine ships', async () => {
    const res = await handlerFor(ReadwiseImportChannels.invoke.SYNC_NOW)({}, undefined)
    expect(res).toMatchObject({ success: false })
    expect(String(res.error)).toMatch(/not available in this build/)
  })
})
