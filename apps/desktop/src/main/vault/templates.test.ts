import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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

// Without this the suite would read the developer's real electron-store and
// resolve legacy template paths inside their actual vault.
let mockVaultPath: string | null = null
vi.mock('../store', () => ({ getCurrentVaultPath: () => mockVaultPath }))

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
import { TemplateNameTakenError } from '../lib/errors'

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

  it('deletes the pre-sync file too, so a fresh data.db cannot re-import it', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tpl-delete-'))
    mockVaultPath = vaultPath
    try {
      const created = await createTemplate({ name: 'Standup', content: 'v1' })

      const legacyDir = path.join(vaultPath, '.memry', 'templates')
      fs.mkdirSync(legacyDir, { recursive: true })
      const legacyFile = path.join(legacyDir, `${created.id}.md`)
      fs.writeFileSync(legacyFile, '---\nname: Standup\n---\nv1')

      // A sibling file must survive: the downgrade path depends on legacy
      // files for templates the user has NOT deleted.
      const otherFile = path.join(legacyDir, 'someone-else.md')
      fs.writeFileSync(otherFile, '---\nname: Other\n---\nx')

      await deleteTemplate(created.id)

      expect(fs.existsSync(legacyFile)).toBe(false)
      expect(fs.existsSync(otherFile)).toBe(true)
    } finally {
      mockVaultPath = null
      fs.rmSync(vaultPath, { recursive: true, force: true })
    }
  })

  it('refuses to modify or delete built-ins', async () => {
    await expect(updateTemplate({ id: 'blank', content: 'x' })).rejects.toThrow(
      'Cannot modify built-in templates'
    )
    await expect(deleteTemplate('blank')).rejects.toThrow('Cannot delete built-in templates')
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

// Two templates with one name cannot be told apart in the picker, so a local
// create or rename that would produce a pair is refused. Rows that already
// share a name (synced from another device, imported from the pre-sync files)
// are left alone.
describe('template names are unique', () => {
  beforeEach(() => {
    testDb = createTestDataDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
  })

  function insertRow(id: string, name: string): void {
    const now = new Date().toISOString()
    testDb.db
      .insert(templatesTable)
      .values({
        id,
        name,
        tags: [],
        properties: [],
        content: 'body',
        createdAt: now,
        modifiedAt: now
      })
      .run()
  }

  function rowCount(): number {
    return testDb.db.select().from(templatesTable).all().length
  }

  it('refuses to create a template named like an existing one', async () => {
    await createTemplate({ name: 'Standup' })
    vi.clearAllMocks()

    await expect(createTemplate({ name: 'Standup' })).rejects.toMatchObject({
      name: 'TemplateNameTakenError',
      code: 'template-name-taken',
      templateName: 'Standup'
    })

    expect(rowCount()).toBe(1)
    expect(enqueueCreate).not.toHaveBeenCalled()
  })

  it.each(['stand up', 'STAND UP', '  Stand up  ', 'Stand   up', 'Stand\u00A0up'])(
    'treats %j as the same name as "Stand up"',
    async (variant) => {
      await createTemplate({ name: 'Stand up' })

      await expect(createTemplate({ name: variant })).rejects.toBeInstanceOf(TemplateNameTakenError)
    }
  )

  it('refuses a name a built-in template has, in any case', async () => {
    await expect(createTemplate({ name: 'meeting notes' })).rejects.toBeInstanceOf(
      TemplateNameTakenError
    )
    expect(rowCount()).toBe(0)
  })

  it('refuses a rename onto another template and leaves the row as it was', async () => {
    await createTemplate({ name: 'Standup' })
    const other = await createTemplate({ name: 'Retro', content: 'keep' })
    vi.clearAllMocks()

    await expect(updateTemplate({ id: other.id, name: ' standup ' })).rejects.toBeInstanceOf(
      TemplateNameTakenError
    )
    await expect(updateTemplate({ id: other.id, name: 'Daily Standup' })).rejects.toBeInstanceOf(
      TemplateNameTakenError
    )

    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, other.id)).get()
    ).toMatchObject({ name: 'Retro', content: 'keep' })
    expect(enqueueUpdate).not.toHaveBeenCalled()
  })

  it('allows a template to be renamed to a free name or re-cased', async () => {
    const created = await createTemplate({ name: 'Standup' })

    expect((await updateTemplate({ id: created.id, name: 'STANDUP' })).name).toBe('STANDUP')
    expect((await updateTemplate({ id: created.id, name: 'Weekly sync' })).name).toBe('Weekly sync')
  })

  it('still edits a template that already shares its name with another, as long as the name is kept', async () => {
    insertRow('twin-a', 'Standup')
    insertRow('twin-b', 'Standup')

    // The editor sends the name with every autosave.
    const updated = await updateTemplate({ id: 'twin-a', name: 'Standup', content: 'edited' })

    expect(updated).toMatchObject({ name: 'Standup', content: 'edited' })
    expect((await updateTemplate({ id: 'twin-b', content: 'edited too' })).content).toBe(
      'edited too'
    )
  })

  it('refuses to rename a duplicate-named template onto a third, taken name', async () => {
    insertRow('twin-a', 'Standup')
    insertRow('twin-b', 'Standup')
    insertRow('other', 'Retro')

    await expect(updateTemplate({ id: 'twin-a', name: 'retro' })).rejects.toBeInstanceOf(
      TemplateNameTakenError
    )
  })

  it('lets a duplicate-named pair be renamed apart', async () => {
    insertRow('twin-a', 'Standup')
    insertRow('twin-b', 'Standup')

    expect((await updateTemplate({ id: 'twin-a', name: 'Standup (old)' })).name).toBe(
      'Standup (old)'
    )
  })

  it('duplicates to a unique name each time', async () => {
    const source = await createTemplate({ name: 'Standup' })

    const first = await duplicateTemplate(source.id, 'Standup (Copy)')
    const second = await duplicateTemplate(source.id, 'Standup (Copy)')
    const third = await duplicateTemplate(source.id, 'standup (copy)')
    // Same name as the source itself.
    const fourth = await duplicateTemplate(source.id, 'Standup')

    expect([first, second, third, fourth].map((t) => t.name)).toEqual([
      'Standup (Copy)',
      'Standup (Copy) 2',
      'standup (copy) 3',
      'Standup 2'
    ])
  })

  it('duplicates a built-in under its own name without colliding with it', async () => {
    const copy = await duplicateTemplate('meeting-notes', 'Meeting Notes')

    expect(copy.name).toBe('Meeting Notes 2')
  })

  it('does not count a row carrying a built-in id, which the list hides', async () => {
    insertRow('blank', 'Ghost name')

    expect((await createTemplate({ name: 'Ghost name' })).name).toBe('Ghost name')
  })
})

// A template is a snapshot. Every note made from one that kept a `{task:<id>}`
// suffix pointed at the same task, so deleting it anywhere left a "Task
// deleted" row in every other note (#2331).
describe('templates never carry a task identity', () => {
  const TASK_BODY = '## Chores\n\n- [ ] Call the plumber {task:t1}\n  - [x] Book a slot {task:t2}'
  const PLAIN_BODY = '## Chores\n\n- [ ] Call the plumber\n  - [x] Book a slot'

  beforeEach(() => {
    testDb = createTestDataDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
  })

  function storedContent(id: string): string | undefined {
    return testDb.db.select().from(templatesTable).where(eq(templatesTable.id, id)).get()?.content
  }

  it('stores a note body saved as a template without its task ids', async () => {
    const created = await createTemplate({ name: 'Chores', content: TASK_BODY })

    expect(created.content).toBe(PLAIN_BODY)
    expect(storedContent(created.id)).toBe(PLAIN_BODY)
  })

  it('stores an edited template body without task ids', async () => {
    const created = await createTemplate({ name: 'Chores', content: 'v1' })

    const updated = await updateTemplate({ id: created.id, content: TASK_BODY })

    expect(updated.content).toBe(PLAIN_BODY)
    expect(storedContent(created.id)).toBe(PLAIN_BODY)
  })

  it('reads a row an older version or another device wrote with task ids as plain checkboxes', async () => {
    const now = new Date().toISOString()
    testDb.db
      .insert(templatesTable)
      .values({
        id: 'legacy-template',
        name: 'Legacy',
        tags: [],
        properties: [],
        content: TASK_BODY,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    const template = await getTemplate('legacy-template')

    expect(template?.content).toBe(PLAIN_BODY)
    expect(applyTemplate(template!, 'New note').content).toBe(PLAIN_BODY)
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
    expect(result.icon).toBeNull()
  })

  it('carries the template icon through so a new note can adopt it', () => {
    const result = applyTemplate(
      {
        id: 'x',
        name: 'X',
        icon: '📝',
        isBuiltIn: false,
        tags: [],
        properties: [],
        content: 'plain',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      },
      'Hello'
    )

    expect(result.icon).toBe('📝')
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
