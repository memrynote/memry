import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { customThemes } from '@memry/db-schema/schema/custom-themes'
import { readThemeFile, writeThemeFile } from '../vault/themes'

let vaultPath: string

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

import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { createTheme, updateTheme, deleteTheme, listThemes, adoptThemeFiles } from './theme-store'
import type { DataDb } from '../database'

describe('theme-store', () => {
  let testDb: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-theme-store-'))
    testDb = createTestDataDb()
    db = testDb.db as unknown as DataDb
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('createTheme inserts a row, writes the file, and enqueues a sync create', () => {
    const theme = createTheme(db, { name: 'Tema 1', base: 'dark' })

    expect(theme.id).toBeTruthy()
    const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, theme.id)).get()
    expect(row).toMatchObject({ name: 'Tema 1', slug: 'tema-1', base: 'dark', variables: {} })
    expect(readThemeFile(vaultPath, 'tema-1')?.id).toBe(theme.id)
    expect(enqueueLocalSyncCreate).toHaveBeenCalledWith('theme', theme.id)
  })

  it('createTheme resolves slug collisions with a numeric suffix', () => {
    createTheme(db, { name: 'Tema 1', base: 'dark' })
    const second = createTheme(db, { name: 'Tema 1', base: 'light' })

    const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, second.id)).get()
    expect(row!.slug).toBe('tema-1-2')
    expect(readThemeFile(vaultPath, 'tema-1-2')?.base).toBe('light')
  })

  it('updateTheme renames slug + file when the name changes and enqueues update', () => {
    const theme = createTheme(db, { name: 'Tema 1', base: 'dark' })

    const updated = updateTheme(db, theme.id, { name: 'Gece' })

    expect(updated?.name).toBe('Gece')
    const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, theme.id)).get()
    expect(row!.slug).toBe('gece')
    expect(readThemeFile(vaultPath, 'tema-1')).toBeNull()
    expect(readThemeFile(vaultPath, 'gece')?.name).toBe('Gece')
    expect(enqueueLocalSyncUpdate).toHaveBeenCalledWith('theme', theme.id)
  })

  it('updateTheme replaces variables', () => {
    const theme = createTheme(db, {
      name: 'Tema 1',
      base: 'dark',
      variables: { '--background': '#101010' }
    })

    updateTheme(db, theme.id, { variables: { '--surface': '#202020' } })

    const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, theme.id)).get()
    expect(row!.variables).toEqual({ '--surface': '#202020' })
    expect(readThemeFile(vaultPath, 'tema-1')?.variables).toEqual({ '--surface': '#202020' })
  })

  it('updateTheme returns null for an unknown id', () => {
    expect(updateTheme(db, 'missing', { name: 'X' })).toBeNull()
  })

  it('deleteTheme removes row + file and enqueues delete with a snapshot', () => {
    const theme = createTheme(db, { name: 'Tema 1', base: 'dark' })

    const removed = deleteTheme(db, theme.id)

    expect(removed).toBe(true)
    expect(
      testDb.db.select().from(customThemes).where(eq(customThemes.id, theme.id)).get()
    ).toBeUndefined()
    expect(readThemeFile(vaultPath, 'tema-1')).toBeNull()
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith('theme', theme.id, expect.any(String))
  })

  it('listThemes returns stored themes as CustomTheme DTOs', () => {
    createTheme(db, { name: 'Tema 1', base: 'dark', variables: { '--background': '#101010' } })

    const themes = listThemes(db)

    expect(themes).toHaveLength(1)
    expect(themes[0]).toMatchObject({
      name: 'Tema 1',
      base: 'dark',
      variables: { '--background': '#101010' }
    })
  })

  it('adoptThemeFiles inserts unclocked rows for orphan files and skips known ids', () => {
    const known = createTheme(db, { name: 'Known', base: 'dark' })
    writeThemeFile(vaultPath, 'orphan', {
      id: 'orphan-id',
      name: 'Orphan',
      base: 'light',
      variables: { '--background': '#ffffff' },
      createdAt: '2026-07-09T10:00:00.000Z',
      modifiedAt: '2026-07-09T10:00:00.000Z'
    })

    const adopted = adoptThemeFiles(db)

    expect(adopted).toBe(1)
    const row = testDb.db.select().from(customThemes).where(eq(customThemes.id, 'orphan-id')).get()
    expect(row).toMatchObject({ name: 'Orphan', slug: 'orphan', base: 'light' })
    expect(row!.clock).toBeNull()
    expect(
      testDb.db.select().from(customThemes).where(eq(customThemes.id, known.id)).get()
    ).toBeDefined()
    expect(adoptThemeFiles(db)).toBe(0)
  })
})
