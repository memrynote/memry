import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import matter from 'gray-matter'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { noteProperties, propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import * as database from '../database'
import { indexVault } from './indexer'
import { PropertyDefinitionsService } from './property-definitions'

vi.mock('./status', () => ({
  getConfig: vi.fn((): VaultConfig => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })),
  emitIndexProgress: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

vi.mock('./property-definition-sync-effects', () => ({
  enqueuePropertyDefinitionUpsert: vi.fn(),
  enqueuePropertyDefinitionDelete: vi.fn(),
  readPropertyDefinitionRow: vi.fn(() => null)
}))

describe('property types a vault scan learns', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  const writeNotes = (notes: Record<string, string>) => {
    for (const [file, frontmatter] of Object.entries(notes)) {
      fs.writeFileSync(path.join(vault.path, file), `---\n${frontmatter}\n---\nbody\n`)
    }
  }

  const types = (name: string) => ({
    data: dataDb.db
      .select({ name: propertyDefinitions.name, type: propertyDefinitions.type })
      .from(propertyDefinitions)
      .all()
      .find((row) => row.name === name)?.type,
    index: indexDb.db
      .select({ name: propertyDefinitions.name, type: propertyDefinitions.type })
      .from(propertyDefinitions)
      .all()
      .find((row) => row.name === name)?.type,
    rows: [
      ...new Set(
        indexDb.db
          .select({ name: noteProperties.name, type: noteProperties.type })
          .from(noteProperties)
          .all()
          .filter((row) => row.name === name)
          .map((row) => row.type)
      )
    ],
    file: (
      matter(fs.readFileSync(path.join(vault.memryDir, 'properties.md'), 'utf8')).data as {
        properties: Record<string, { type: string }>
      }
    ).properties[name]?.type
  })

  beforeEach(async () => {
    vault = createTestVault('property-types')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => undefined)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    await PropertyDefinitionsService.init(vault.path).reload()
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    PropertyDefinitionsService.destroy()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it.each([
    ['the word first', { 'a.md': 'rating: good', 'b.md': 'rating: 5', 'c.md': 'rating: 4' }],
    ['the word last', { 'a.md': 'rating: 5', 'b.md': 'rating: 4', 'c.md': 'rating: good' }]
  ])(
    'settles conflicting values on text whatever order the scan reads them (%s)',
    async (_, notes) => {
      writeNotes(notes)

      await indexVault(vault.path)

      expect(types('rating')).toEqual({ data: 'text', index: 'text', rows: ['text'], file: 'text' })
    }
  )

  it('keeps a learned type every value fits', async () => {
    writeNotes({ 'a.md': 'rating: 5', 'b.md': 'rating: 4' })

    await indexVault(vault.path)

    expect(types('rating')).toEqual({
      data: 'number',
      index: 'number',
      rows: ['number'],
      file: 'number'
    })
  })

  it('never changes a type the user chose', async () => {
    await PropertyDefinitionsService.get().upsert({ name: 'rating', type: 'number' })
    writeNotes({ 'a.md': 'rating: good', 'b.md': 'rating: 5' })

    await indexVault(vault.path)

    expect(types('rating')).toEqual({
      data: 'number',
      index: 'number',
      rows: ['number'],
      file: 'number'
    })
  })
})
