import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

let vaultPath: string

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('../database', () => ({
  requireDatabase: vi.fn(() => {
    throw new Error('No vault is open')
  })
}))

vi.mock('../vault/index', () => ({
  getStatus: () => ({ path: vaultPath })
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { makeThemesHandlers, registerThemesHandlers } from './themes-handlers'
import type { DrizzleDb } from '../sync/item-handlers/types'

describe('registerThemesHandlers — lazy DB resolution', () => {
  it('does not throw at registration and registers all 4 channels', async () => {
    const { ipcMain } = await import('electron')
    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()

    expect(() => registerThemesHandlers()).not.toThrow()
    expect(handleMock.mock.calls.length).toBe(4)
  })
})

describe('themes handlers', () => {
  let dbResult: TestDatabaseResult
  let h: ReturnType<typeof makeThemesHandlers>

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-themes-ipc-'))
    dbResult = createTestDataDb()
    h = makeThemesHandlers(dbResult.db as unknown as DrizzleDb)
  })

  afterEach(() => {
    dbResult.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('creates and lists themes', () => {
    const created = h.create({ name: 'Tema 1', base: 'dark' })
    expect(created.success).toBe(true)
    expect(created.theme?.name).toBe('Tema 1')

    const themes = h.list()
    expect(themes).toHaveLength(1)
    expect(themes[0].base).toBe('dark')
  })

  it('updates a theme and returns the updated DTO', () => {
    const created = h.create({ name: 'Tema 1', base: 'dark' })

    const result = h.update({
      id: created.theme!.id,
      variables: { '--background': '#101010' }
    })

    expect(result.success).toBe(true)
    expect(result.theme?.variables).toEqual({ '--background': '#101010' })
  })

  it('returns an error for updating an unknown theme', () => {
    const result = h.update({ id: 'missing', name: 'X' })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('deletes a theme', () => {
    const created = h.create({ name: 'Tema 1', base: 'dark' })

    expect(h.delete({ id: created.theme!.id }).success).toBe(true)
    expect(h.list()).toHaveLength(0)
    expect(h.delete({ id: created.theme!.id }).success).toBe(false)
  })

  it('list adopts orphan vault files', () => {
    fs.mkdirSync(path.join(vaultPath, '.memry', 'themes'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultPath, '.memry', 'themes', 'orphan.json'),
      JSON.stringify({
        id: 'orphan-id',
        name: 'Orphan',
        base: 'light',
        variables: {},
        createdAt: '2026-07-09T10:00:00.000Z',
        modifiedAt: '2026-07-09T10:00:00.000Z'
      }),
      'utf-8'
    )

    const themes = h.list()
    expect(themes.map((t) => t.id)).toContain('orphan-id')
  })
})
