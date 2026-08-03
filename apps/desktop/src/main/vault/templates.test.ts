import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { templates as templatesTable } from '@memry/db-schema/schema/templates'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const enqueueCreate = vi.fn()
const enqueueUpdate = vi.fn()
const enqueueDelete = vi.fn()

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...args: unknown[]) => enqueueCreate(...args),
  enqueueLocalSyncUpdate: (...args: unknown[]) => enqueueUpdate(...args),
  enqueueLocalSyncDelete: (...args: unknown[]) => enqueueDelete(...args)
}))

let testDb: TestDatabaseResult
vi.mock('../database', () => ({ getDatabase: () => testDb.db }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  applyTemplate,
  BUILT_IN_TEMPLATES
} from './templates'

describe('templates CRUD', () => {
  beforeEach(() => {
    testDb = createTestDataDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
  })

  it('lists built-ins from code with no DB rows and no files', async () => {
    const list = await listTemplates()

    expect(list.length).toBe(BUILT_IN_TEMPLATES.length)
    expect(list.every((t) => t.isBuiltIn)).toBe(true)
    expect(testDb.db.select().from(templatesTable).all()).toEqual([])
  })

  it('serves a built-in by id without touching the DB', async () => {
    const blank = await getTemplate('blank')
    expect(blank).toMatchObject({ id: 'blank', isBuiltIn: true })
  })

  it('returns null for an unknown id', async () => {
    expect(await getTemplate('nope')).toBeNull()
  })

  it('creates a custom template as a row and enqueues it for sync', async () => {
    const created = await createTemplate({ name: 'Standup', content: '## Blockers' })

    expect(created.isBuiltIn).toBe(false)
    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, created.id)).get()
    ).toMatchObject({ name: 'Standup', content: '## Blockers' })
    // Registry wiring alone does nothing — the mutation must enqueue.
    expect(enqueueCreate).toHaveBeenCalledWith('template', created.id)
  })

  it('sorts built-ins first, then custom by name', async () => {
    await createTemplate({ name: 'AAA Custom', content: '' })

    const list = await listTemplates()

    expect(list[0].isBuiltIn).toBe(true)
    expect(list[list.length - 1]).toMatchObject({ name: 'AAA Custom', isBuiltIn: false })
  })

  it('updates a custom template and enqueues an update', async () => {
    const created = await createTemplate({ name: 'Standup', content: 'v1' })
    vi.clearAllMocks()

    const updated = await updateTemplate({ id: created.id, content: 'v2' })

    expect(updated.content).toBe('v2')
    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, created.id)).get()
        ?.content
    ).toBe('v2')
    expect(enqueueUpdate).toHaveBeenCalledWith('template', created.id)
  })

  it('deletes a custom template and enqueues a delete with a snapshot payload', async () => {
    const created = await createTemplate({ name: 'Standup', content: 'v1' })
    vi.clearAllMocks()

    await deleteTemplate(created.id)

    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, created.id)).get()
    ).toBeUndefined()
    expect(enqueueDelete).toHaveBeenCalledWith('template', created.id, expect.any(String))
    // Without the snapshot the tombstone never reaches the other device.
    const snapshot = JSON.parse(enqueueDelete.mock.calls[0][2] as string)
    expect(snapshot).toMatchObject({ id: created.id, name: 'Standup' })
  })

  it('refuses to modify or delete built-ins', async () => {
    await expect(updateTemplate({ id: 'blank', content: 'x' })).rejects.toThrow()
    await expect(deleteTemplate('blank')).rejects.toThrow()
    expect(enqueueUpdate).not.toHaveBeenCalled()
    expect(enqueueDelete).not.toHaveBeenCalled()
  })

  it('throws NOT_FOUND when updating or deleting a missing custom template', async () => {
    await expect(updateTemplate({ id: 'missing', content: 'x' })).rejects.toThrow(/not found/i)
    await expect(deleteTemplate('missing')).rejects.toThrow(/not found/i)
  })

  it('duplicating a built-in produces a syncable custom template that keeps content and tags', async () => {
    const copy = await duplicateTemplate('meeting-notes', 'My Meeting Notes')

    expect(copy.isBuiltIn).toBe(false)
    expect(copy.name).toBe('My Meeting Notes')
    expect(copy.content).toContain('## Agenda')
    expect(copy.tags).toEqual(['meeting'])
    expect(enqueueCreate).toHaveBeenCalledWith('template', copy.id)
  })

  it('throws when duplicating a non-existent template', async () => {
    await expect(duplicateTemplate('nonexistent', 'Copy')).rejects.toThrow(/not found/i)
  })
})

describe('applyTemplate', () => {
  it('replaces the {{title}} placeholder, copies tags, and flattens properties', () => {
    const result = applyTemplate(
      {
        id: 'x',
        name: 'X',
        icon: null,
        isBuiltIn: false,
        tags: ['a', 'b'],
        properties: [
          { name: 'status', type: 'select', value: 'todo' },
          { name: 'date', type: 'date', value: null }
        ],
        content: '# {{title}}\n\nAbout {{title}}.',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      },
      'Hello'
    )

    expect(result.content).toBe('# Hello\n\nAbout Hello.')
    expect(result.tags).toEqual(['a', 'b'])
    expect(result.properties).toEqual({ status: 'todo', date: null })
  })

  it('handles a template without properties', () => {
    const result = applyTemplate(
      {
        id: 'x',
        name: 'X',
        icon: null,
        isBuiltIn: false,
        tags: [],
        properties: [],
        content: 'plain',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      },
      'Hello'
    )

    expect(result.content).toBe('plain')
    expect(result.properties).toEqual({})
  })
})
