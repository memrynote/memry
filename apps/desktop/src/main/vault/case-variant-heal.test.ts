/**
 * Vault open drops the copies an earlier case-only folder rename indexed under
 * the old spelling, and keeps every file and every note the disk spells.
 *
 * @module vault/case-variant-heal.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  updateFtsContent: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { healCaseVariantRows } from './case-variant-heal'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('healCaseVariantRows', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-heal')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    index.close()
    data.close()
    vault.cleanup()
  })

  function writeFile(relativePath: string, body: string): void {
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, body)
  }

  function seedRows(
    id: string,
    relativePath: string,
    options: { contentHash?: string; synced?: boolean } = {}
  ): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, '.md'),
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: options.synced ? '2026-01-12T00:00:00.000Z' : null
    }
    insertNoteCache(index.db, {
      ...fields,
      fileSize: 4,
      contentHash: options.contentHash ?? `hash-${id}`
    })
    data.db.insert(noteMetadata).values(fields).run()
  }

  function seedFolder(folderPath: string, icon: string | null, synced = false): void {
    data.db
      .insert(folderConfigs)
      .values({
        path: folderPath,
        icon,
        clock: synced ? { peer: 1 } : null,
        createdAt: 'x',
        modifiedAt: 'x'
      })
      .run()
  }

  const notes = () => ({
    canonical: data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    index: index.db
      .select({ id: noteCache.id, path: noteCache.path })
      .from(noteCache)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))
  })
  const folders = () =>
    data.db
      .select({ path: folderConfigs.path, icon: folderConfigs.icon })
      .from(folderConfigs)
      .all()
      .toSorted((a, b) => a.path.localeCompare(b.path))

  it.runIf(fileSystemIgnoresCase())(
    'drops the old-case copies of renamed notes and folders, keeping the files',
    async () => {
      writeFile('SuperNotes/Sub/a.md', 'body')
      // The old watcher indexed the one file again: the copy has its body.
      seedRows('original', 'SuperNotes/Sub/a.md', { contentHash: 'hash-body' })
      seedRows('copy', 'Supernotes/Sub/a.md', { contentHash: 'hash-body' })
      // The disk has the old spelling here, and no row has the new one.
      writeFile('Other/b.md', 'kept')
      seedRows('lone', 'other/b.md')
      seedFolder('SuperNotes', 'star')
      seedFolder('SuperNotes/Sub', null)
      seedFolder('Supernotes/Sub', null)

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 1, folders: 1 })

      const kept = [
        { id: 'lone', path: 'other/b.md' },
        { id: 'original', path: 'SuperNotes/Sub/a.md' }
      ]
      expect(notes()).toEqual({ canonical: kept, index: kept })
      expect(folders()).toEqual([
        { path: 'SuperNotes', icon: 'star' },
        { path: 'SuperNotes/Sub', icon: null }
      ])
      expect(fs.readFileSync(path.join(vault.path, 'SuperNotes/Sub/a.md'), 'utf8')).toBe('body')
      expect(fs.readFileSync(path.join(vault.path, 'Other/b.md'), 'utf8')).toBe('kept')
    }
  )

  // A copy is the kept note's body indexed again, pushed or not. A row with its
  // own body is a distinct note, whether it ever synced or not (#5297).
  it.runIf(fileSystemIgnoresCase())(
    'drops a synced copy of the same body and keeps case twins, synced or not',
    async () => {
      writeFile('SuperNotes/a.md', 'body')
      seedRows('original', 'SuperNotes/a.md', { contentHash: 'hash-body', synced: true })
      seedRows('copy', 'Supernotes/a.md', { contentHash: 'hash-body', synced: true })
      seedRows('twin', 'SUPERNOTES/a.md', { contentHash: 'hash-twin', synced: true })
      seedRows('local-twin', 'supernotes/A.md', { contentHash: 'hash-local' })

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 1, folders: 0 })
      expect(notes().canonical.map((row) => row.id)).toEqual(['local-twin', 'original', 'twin'])
    }
  )

  // A folder row with a clock can be a server record, and a dropped one comes
  // back by the next manifest check only to be dropped again (#5327). An
  // unsynced row with the kept row's icon holds nothing, so it still goes.
  it.runIf(fileSystemIgnoresCase())(
    'drops only an unsynced folder copy with the kept icon, keeping folder twins',
    async () => {
      fs.mkdirSync(path.join(vault.path, 'SuperNotes'))
      seedFolder('SuperNotes', 'star', true)
      seedFolder('Supernotes', 'star', true)
      seedFolder('SUPERNOTES', 'moon')
      seedFolder('supernotes', 'star')

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 1 })
      expect(new Set(folders().map((row) => row.path))).toEqual(
        new Set(['SUPERNOTES', 'SuperNotes', 'Supernotes'])
      )
    }
  )

  it.runIf(!fileSystemIgnoresCase())(
    'keeps paths that differ only in case when each is its own file',
    async () => {
      writeFile('SuperNotes/a.md', 'one')
      writeFile('Supernotes/a.md', 'two')
      seedRows('upper', 'SuperNotes/a.md')
      seedRows('lower', 'Supernotes/a.md')
      seedFolder('SuperNotes', null)
      seedFolder('Supernotes', null)

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 0 })

      const kept = [
        { id: 'lower', path: 'Supernotes/a.md' },
        { id: 'upper', path: 'SuperNotes/a.md' }
      ]
      expect(notes()).toEqual({ canonical: kept, index: kept })
      expect(
        folders()
          .map((row) => row.path)
          .toSorted()
      ).toEqual(['SuperNotes', 'Supernotes'])
    }
  )
})
