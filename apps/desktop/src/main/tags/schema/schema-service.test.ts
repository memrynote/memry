/**
 * Tag schema writes through the real data.db, the real tag_definition sync
 * service and queue, the real property definitions file and the real
 * templates table. Stood in for: the windows (no renderer to broadcast to).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { templates } from '@memry/db-schema/schema/templates'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { createMainI18n } from '@memry/i18n/main'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../database/client')>()),
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))

import { getAllTagsWithCounts } from '@main/database/queries/tags'
import { __resetMainI18nForTest, setMainI18n } from '../../lib/main-i18n'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { addPreset } from '../presets'
import { runTagSchemaCommand } from './commands'
import { rewriteSchemaReferences } from './references'
import { saveTagViews } from './views'

let vault: TestVaultResult
let data: TestDatabaseResult
let index: TestDatabaseResult
let queue: SyncQueueManager
const noProgress = (): void => {}

beforeEach(async () => {
  vault = createTestVault('tag-schema')
  data = createTestDataDb()
  index = createTestIndexDb()
  state.data = data.db
  state.index = index.db
  queue = new SyncQueueManager(asSyncDb(data.db))
  initTagDefinitionSyncService({ queue, db: asSyncDb(data.db), getDeviceId: () => 'device-a' })
  PropertyDefinitionsService.init(vault.path)
  await PropertyDefinitionsService.get().reloadOnOpen()
})

afterEach(() => {
  resetTagDefinitionSyncService()
  PropertyDefinitionsService.destroy()
  __resetMainI18nForTest()
  data.close()
  index.close()
  vault.cleanup()
})

const db = () => asClientDb(data.db)
const indexDb = () => index.db as never
const run = (command: Parameters<typeof runTagSchemaCommand>[2]) =>
  runTagSchemaCommand(db(), indexDb(), command, noProgress)

function row(name: string) {
  const stored = data.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
  return stored && { ...stored, schema: stored.schema ? JSON.parse(stored.schema) : null }
}

const queued = (name: string) =>
  queue.peek(100).filter((item) => item.type === 'tag_definition' && item.itemId === name)

describe('schema edits', () => {
  it('creates the definition, stores t = 1, queues it and ticks the clock', async () => {
    const { snapshot } = await run({
      kind: 'add-field',
      tag: 'Person',
      field: { name: 'Role', type: 'text' }
    })

    expect(row('person')).toMatchObject({
      name: 'person',
      schema: { t: 1, fields: [{ name: 'Role' }] },
      clock: { 'device-a': 1 }
    })
    expect(queued('person')).toHaveLength(1)
    expect(JSON.parse(queued('person')[0].payload)).toMatchObject({
      schema: { t: 1, fields: [{ name: 'Role' }] }
    })
    expect(PropertyDefinitionsService.get().get('Role')).toMatchObject({ type: 'text' })
    expect(snapshot.tags.person.effectiveFields).toMatchObject([{ name: 'Role', type: 'text' }])
  })

  it('queues nothing for an edit that changes nothing', async () => {
    await run({ kind: 'add-field', tag: 'person', field: { name: 'Role', type: 'text' } })
    queue.clear()

    await run({ kind: 'set-template', tag: 'person', template: null })
    await run({ kind: 'move-field', tag: 'person', name: 'Role', toIndex: 0 })

    expect(row('person')?.schema.t).toBe(1)
    expect(queue.peek(100)).toEqual([])
  })

  it('reuses the vault spelling of a name and refuses a refused edit without side effects', async () => {
    await PropertyDefinitionsService.get().upsert({ name: 'Email', type: 'url' })
    await run({ kind: 'add-field', tag: 'person', field: { name: 'email', type: 'text' } })
    expect(row('person')?.schema.fields).toEqual([{ name: 'Email' }])
    expect(PropertyDefinitionsService.get().get('Email')?.type).toBe('url')

    await expect(
      run({ kind: 'add-field', tag: 'person', field: { name: 'Tags', type: 'text' } })
    ).rejects.toThrow('"Tags" is reserved')
    expect(PropertyDefinitionsService.get().get('Tags')).toBeUndefined()
  })
})

describe('views', () => {
  it('creates the definition row a never-indexed tag lacks, and queues the views', () => {
    saveTagViews(db(), 'Reading', [{ name: 'All', type: 'table' }])

    expect(row('reading')?.views).toBe('[{"name":"All","type":"table"}]')
    expect(queued('reading')).toHaveLength(1)
  })
})

describe('ready-made tags', () => {
  it('adds relation targets first, links them, and is a no-op the second time', async () => {
    const meeting = await addPreset(db(), 'meeting')

    expect(meeting).toBe('meeting')
    expect(row('meeting')?.schema).toMatchObject({
      t: 1,
      preset: 'meeting',
      template: { autofill: true },
      fields: [
        { name: 'Date' },
        { name: 'Attendees', relation: { target: 'person', many: true, inverse: 'Meetings' } },
        { name: 'Company', relation: { target: 'company', many: false, inverse: 'Meetings' } }
      ]
    })
    expect(row('person')?.schema).toMatchObject({ preset: 'person' })
    expect(row('company')?.schema).toMatchObject({ preset: 'company' })
    expect(row('person')).toMatchObject({ colorAuthored: true, icon: 'icon:UserIcon' })
    expect(PropertyDefinitionsService.get().get('Date')).toMatchObject({
      type: 'date',
      showOnCalendar: true
    })
    const templateCount = data.db.select().from(templates).all().length
    expect(templateCount).toBe(3)
    queue.clear()

    await addPreset(db(), 'meeting')
    await addPreset(db(), 'person')

    expect(row('meeting')?.schema.t).toBe(1)
    expect(data.db.select().from(templates).all()).toHaveLength(templateCount)
    expect(queue.peek(100)).toEqual([])
  })

  it('merges into an existing tag, keeping its own fields first', async () => {
    await run({ kind: 'add-field', tag: 'person', field: { name: 'Nickname', type: 'text' } })
    const { snapshot } = await run({ kind: 'add-preset', preset: 'person' })

    expect(snapshot.tags.person.ownFields.map((f) => f.name)).toEqual([
      'Nickname',
      'Company',
      'Role',
      'Email',
      'Phone'
    ])
    expect(snapshot.presets.find((p) => p.key === 'person')?.state).toBe('added')
  })

  it('names tags and fields in the app language, tags lowercase', async () => {
    setMainI18n(await createMainI18n({ locale: 'tr' }))

    const { snapshot } = await run({ kind: 'add-preset', preset: 'person' })

    expect(snapshot.tags['kişi']).toMatchObject({ name: 'kişi', preset: 'person' })
    expect(snapshot.tags['kişi'].ownFields.map((f) => f.name)).toEqual([
      'Şirket',
      'Rol',
      'E-posta',
      'Telefon'
    ])
    expect(snapshot.tags['kişi'].ownFields[0].relation?.target).toBe('şirket')
    expect(snapshot.tags['şirket']).toMatchObject({ preset: 'company' })
  })

  it('offers each preset with what it would add, and remembers a dismissal', async () => {
    await run({ kind: 'add-field', tag: 'book', field: { name: 'Pages', type: 'number' } })
    const { snapshot } = await run({ kind: 'dismiss-preset-offer' })

    expect(snapshot.presetStripDismissed).toBe(true)
    expect(snapshot.presets.map((p) => [p.key, p.state, p.alsoAdds])).toEqual([
      ['person', 'add', ['company']],
      ['company', 'add', []],
      ['meeting', 'add', ['person', 'company']],
      ['book', 'add-fields', []]
    ])
  })
})

describe('tag lifecycle', () => {
  it('keeps an unused tag that has a schema when unused tags are collected', async () => {
    await run({ kind: 'add-field', tag: 'idea', field: { name: 'Stage', type: 'text' } })
    data.db.insert(tagDefinitions).values({ name: 'leftover', color: 'blue' }).run()

    const names = getAllTagsWithCounts(index.db as never, db()).map((tag) => tag.name)

    expect(names).toEqual(['idea'])
    expect(row('leftover')).toBeUndefined()
  })

  it('points other schemas at a renamed tag, bumping t once each', async () => {
    await addPreset(db(), 'meeting')
    await run({ kind: 'set-extends', tag: 'employee', parent: 'person' })
    queue.clear()

    expect(rewriteSchemaReferences(db(), 'person', 'contact').sort()).toEqual([
      'employee',
      'meeting'
    ])
    expect(row('employee')?.schema).toMatchObject({ t: 2, extends: 'contact' })
    expect(row('meeting')?.schema.t).toBe(2)
    expect(row('meeting')?.schema.fields[1].relation.target).toBe('contact')
    expect(queued('employee')).toHaveLength(1)
    expect(queued('meeting')).toHaveLength(1)
  })
})
