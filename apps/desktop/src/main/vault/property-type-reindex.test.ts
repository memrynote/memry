import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import {
  getNoteProperties,
  insertNoteCache,
  insertPropertyDefinition,
  setNoteProperties,
  updatePropertyDefinition
} from '@main/database/queries/notes'
import { retypeIndexedProperties } from './property-type-reindex'

describe('retypeIndexedProperties', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let root: string
  let vault: string

  const indexNote = (id: string, file: string): void => {
    insertNoteCache(db, {
      id,
      path: file,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      modifiedAt: '2026-10-01T00:00:00.000Z'
    })
    setNoteProperties(db, id, { due: '2026-10-01' }, () => 'date')
  }
  const typeOf = (id: string): string | undefined =>
    getNoteProperties(db, id).find((p) => p.name === 'due')?.type

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
    root = mkdtempSync(path.join(tmpdir(), 'retype-'))
    vault = path.join(root, 'vault')
    mkdirSync(vault)
    insertPropertyDefinition(db, {
      name: 'due',
      type: 'date',
      options: null,
      defaultValue: null,
      color: null
    })
  })

  afterEach(() => {
    dbResult.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('re-types a vault note and skips a note that links outside the vault', async () => {
    writeFileSync(path.join(vault, 'inside.md'), "---\ndue: '2026-10-01'\n---\n")
    writeFileSync(path.join(root, 'secret.md'), "---\ndue: '2026-10-01'\n---\n")
    symlinkSync(path.join(root, 'secret.md'), path.join(vault, 'outside.md'))
    indexNote('inside', 'inside.md')
    indexNote('outside', 'outside.md')
    updatePropertyDefinition(db, 'due', { type: 'text' })

    const retyped = await retypeIndexedProperties(db, vault, ['due'])

    expect(retyped).toBe(1)
    expect(typeOf('inside')).toBe('text')
    expect(typeOf('outside')).toBe('date')
  })
})
