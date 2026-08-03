import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import matter from 'gray-matter'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getSetting } from '../database/queries/settings'
import { migrateTemplateFilesToDb } from './templates-migration'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

let vaultPath: string
let testDb: TestDatabaseResult

function writeTemplateFile(id: string, frontmatter: Record<string, unknown>, body: string): void {
  const dir = path.join(vaultPath, '.memry', 'templates')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.md`), matter.stringify(body, frontmatter))
}

describe('migrateTemplateFilesToDb', () => {
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tpl-migration-'))
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('imports a custom template preserving its frontmatter id', () => {
    writeTemplateFile(
      'abc123',
      {
        id: 'abc123',
        name: 'My Standup',
        isBuiltIn: false,
        tags: ['daily'],
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-02T00:00:00.000Z'
      },
      '## Blockers'
    )

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)

    const rows = testDb.db.select().from(templates).all()
    expect(rows).toHaveLength(1)
    // The id MUST be preserved: a vault copied across devices must converge by
    // LWW rather than duplicate.
    expect(rows[0]).toMatchObject({
      id: 'abc123',
      name: 'My Standup',
      content: '## Blockers',
      tags: ['daily'],
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    // clock is NULL so seedUnclocked picks it up and pushes it.
    expect(rows[0].clock).toBeNull()
  })

  it('skips built-in templates', () => {
    writeTemplateFile('blank', { id: 'blank', name: 'Blank Note', isBuiltIn: true }, '')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
    expect(testDb.db.select().from(templates).all()).toEqual([])
  })

  it('is idempotent and does not resurrect deleted templates', () => {
    writeTemplateFile('abc123', { id: 'abc123', name: 'My Standup', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(getSetting(testDb.db as never, 'templates.importedFromFiles')).toBe('1')

    // Simulate the user deleting the template after migration.
    testDb.db.delete(templates).run()

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
    expect(testDb.db.select().from(templates).all()).toEqual([])
  })

  it('leaves the legacy files on disk as a downgrade path', () => {
    writeTemplateFile('abc123', { id: 'abc123', name: 'My Standup', isBuiltIn: false }, 'body')

    migrateTemplateFilesToDb(testDb.db as never, vaultPath)

    expect(fs.existsSync(path.join(vaultPath, '.memry', 'templates', 'abc123.md'))).toBe(true)
  })

  it('falls back to the filename when frontmatter has no id', () => {
    writeTemplateFile('legacy-name', { name: 'Legacy', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(testDb.db.select().from(templates).all()[0]).toMatchObject({ id: 'legacy-name' })
  })

  it('is a no-op when the templates directory does not exist', () => {
    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
  })

  it('skips unparseable files without aborting the migration', () => {
    const dir = path.join(vaultPath, '.memry', 'templates')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\nname: [unclosed\n')
    writeTemplateFile('good', { id: 'good', name: 'Good', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(testDb.db.select().from(templates).all()[0]).toMatchObject({ id: 'good' })
  })
})
