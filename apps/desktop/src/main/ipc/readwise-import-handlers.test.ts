import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { insertThisDevice } from '@tests/utils/sync-device'
import sodium from 'libsodium-wrappers-sumo'
import { mockApp, mockElectron } from '@tests/utils/mock-electron'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { ReadwiseImportChannels } from '@memry/contracts/import-channels'
import type { DataDb } from '../database/types'
import { setSetting } from '../database/queries/settings'

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
    markSyncIneligible()
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
    registerReadwiseImportHandlers()
  })
  afterEach(() => {
    resetSyncDecision()
    unregisterReadwiseImportHandlers()
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
  })

  it('registers every channel and removes them again', () => {
    for (const channel of Object.values(ReadwiseImportChannels.invoke)) handlerFor(channel)
    unregisterReadwiseImportHandlers()
    for (const channel of Object.values(ReadwiseImportChannels.invoke)) {
      expect(mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('status reports disconnected with defaults on a fresh vault', async () => {
    const status = await handlerFor(ReadwiseImportChannels.invoke.STATUS)({}, undefined)
    expect(status).toMatchObject({ connected: false, hasImported: false })
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

  it('take-over answers a failure envelope when sync is off, and stores nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    const res = await handlerFor(ReadwiseImportChannels.invoke.TAKE_OVER)({}, { token: TOKEN })
    expect(res).toMatchObject({ success: false })
    expect(String(res.error)).toMatch(/Turn on sync/)
    expect(secrets.size).toBe(0)
  })

  it('take-over rejects an empty token at the schema', async () => {
    await expect(
      handlerFor(ReadwiseImportChannels.invoke.TAKE_OVER)({}, { token: '  ' })
    ).rejects.toThrow()
  })

  it('sync-now answers a failure envelope when Readwise is not connected', async () => {
    const res = await handlerFor(ReadwiseImportChannels.invoke.SYNC_NOW)({}, undefined)
    expect(res).toMatchObject({ success: false })
    expect(String(res.error)).toMatch(/not connected/)
  })

  it('sync-now runs the engine against an empty account, completes, and records the run', async () => {
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        requested.push(new URL(input).pathname)
        return input.includes('/auth/')
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ nextPageCursor: null, results: [] }), { status: 200 })
      })
    )
    await handlerFor(ReadwiseImportChannels.invoke.CONNECT)({}, { token: TOKEN })

    const res = await handlerFor(ReadwiseImportChannels.invoke.SYNC_NOW)({}, undefined)

    expect(res).toEqual({ success: true })
    expect(requested).toContain('/api/v2/export/')
    const status = await handlerFor(ReadwiseImportChannels.invoke.STATUS)({}, undefined)
    expect(status).toMatchObject({ connected: true, hasImported: true, needsAttention: false })
    expect(status.lastSyncAt).toEqual(expect.any(String))
  })

  it('status says this device pulls until another device holds the claim', async () => {
    const status = handlerFor(ReadwiseImportChannels.invoke.STATUS)
    expect(await status({}, undefined)).toMatchObject({
      thisDevicePulls: true,
      pullingDeviceName: null
    })
    setSetting(currentDb!, 'readwise', JSON.stringify({ syncDeviceId: 'other-device' }))
    insertThisDevice(currentDb!)
    markSyncEligible()
    expect(await status({}, undefined)).toMatchObject({ thisDevicePulls: false })
  })

  it('refuses the four book commands over IPC on a device that does not pull', async () => {
    setSetting(currentDb!, 'readwise', JSON.stringify({ syncDeviceId: 'other-device' }))
    insertThisDevice(currentDb!)
    markSyncEligible()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const calls: Array<[string, unknown]> = [
      [ReadwiseImportChannels.invoke.REIMPORT_BOOK, { noteId: 'n1' }],
      [ReadwiseImportChannels.invoke.REFRESH_BOOK, { noteId: 'n1' }],
      [ReadwiseImportChannels.invoke.LIST_DELETED, undefined],
      [ReadwiseImportChannels.invoke.RESTORE_BOOK, { readwiseBookId: 1 }]
    ]
    for (const [channel, input] of calls) {
      const res = await handlerFor(channel)({}, input)
      expect(res).toMatchObject({ success: false })
      expect(String(res.error)).toMatch(/Readwise syncs on another device/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
