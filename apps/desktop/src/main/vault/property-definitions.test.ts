import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectOption, StatusCategories } from '@memry/contracts/property-types'

const {
  atomicWriteMock,
  safeReadMock,
  getMemryDirMock,
  getDatabaseMock,
  getIndexDatabaseMock,
  enqueueUpsertMock,
  enqueueDeleteMock
} = vi.hoisted(() => ({
  atomicWriteMock: vi.fn(),
  safeReadMock: vi.fn(),
  getMemryDirMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getIndexDatabaseMock: vi.fn(),
  enqueueUpsertMock: vi.fn(),
  enqueueDeleteMock: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn()
  })
}))

vi.mock('./file-ops', () => ({
  atomicWrite: atomicWriteMock,
  safeRead: safeReadMock
}))

vi.mock('./init', () => ({
  getMemryDir: getMemryDirMock
}))

vi.mock('../database', () => ({
  getDatabase: getDatabaseMock,
  getIndexDatabase: getIndexDatabaseMock
}))

vi.mock('./property-definition-sync-effects', () => ({
  enqueuePropertyDefinitionUpsert: enqueueUpsertMock,
  enqueuePropertyDefinitionDelete: enqueueDeleteMock,
  readPropertyDefinitionRow: vi.fn(() => null)
}))

import { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } from './property-definitions'

type DbRow = {
  name: string
  type: string
  options: string | null
  defaultValue: string | null
  color: string | null
  clock?: Record<string, number> | null
  syncedAt?: string | null
}

function createDbMock() {
  const rows: DbRow[] = []
  const deleteRun = vi.fn(() => {
    rows.length = 0
  })
  const values = vi.fn((row: DbRow) => ({
    run: vi.fn(() => {
      rows.push(row)
    })
  }))
  // `rebuildSingleDbCache` reads the table before it clears it, so it can carry
  // each row's clock across. A fake without `select` sent that read into the
  // rebuild's catch and the delete never ran.
  const all = vi.fn(() => rows.map((row) => ({ ...row })))
  const clocked = vi.fn(() => rows.filter((row) => row.clock != null).map((row) => ({ ...row })))
  return {
    rows,
    deleteRun,
    values,
    db: {
      delete: vi.fn(() => ({ run: deleteRun })),
      insert: vi.fn(() => ({ values })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ all, where: vi.fn(() => ({ all: clocked })) }))
      }))
    }
  }
}

function propertiesFile(properties: string) {
  return `---\nproperties:\n${properties}---\n`
}

function statusCategories(): StatusCategories {
  return {
    todo: {
      label: 'To-do',
      options: [{ value: 'Backlog', color: 'stone', default: true }]
    },
    in_progress: {
      label: 'Doing',
      options: [{ value: 'Working', color: 'amber' }]
    },
    done: {
      label: 'Done',
      options: [{ value: 'Shipped', color: 'emerald' }]
    }
  }
}

describe('PropertyDefinitionsService', () => {
  let dataDb: ReturnType<typeof createDbMock>
  let indexDb: ReturnType<typeof createDbMock>

  beforeEach(() => {
    vi.clearAllMocks()
    PropertyDefinitionsService.destroy()
    dataDb = createDbMock()
    indexDb = createDbMock()
    getMemryDirMock.mockReturnValue('/vault/.memry')
    getDatabaseMock.mockReturnValue(dataDb.db)
    getIndexDatabaseMock.mockReturnValue(indexDb.db)
    safeReadMock.mockResolvedValue(null)
    atomicWriteMock.mockResolvedValue(undefined)
  })

  it('initializes a singleton and resolves properties.md inside the vault metadata dir', () => {
    expect(() => PropertyDefinitionsService.get()).toThrow(
      'PropertyDefinitionsService not initialized'
    )

    const service = PropertyDefinitionsService.init('/vault')

    expect(PropertyDefinitionsService.get()).toBe(service)
    expect(service.filePath).toBe('/vault/.memry/properties.md')
    expect(getMemryDirMock).toHaveBeenCalledWith('/vault')
  })

  it('reloads valid frontmatter into memory and both DB caches', async () => {
    safeReadMock.mockResolvedValue(
      propertiesFile(`
  Stage:
    type: select
    options:
      - value: Idea
        color: sky
  Status:
    type: status
    categories:
      todo:
        label: To-do
        options:
          - value: Backlog
            color: stone
            default: true
      in_progress:
        label: Doing
        options:
          - value: Working
            color: amber
      done:
        label: Done
        options:
          - value: Shipped
            color: emerald
`)
    )

    const service = PropertyDefinitionsService.init('/vault')
    await service.reload()

    expect(service.get('Stage')).toEqual({
      name: 'Stage',
      type: 'select',
      options: [{ value: 'Idea', color: 'sky' }]
    })
    expect(service.get('Status')).toEqual({
      name: 'Status',
      type: 'status',
      categories: statusCategories()
    })
    expect(dataDb.deleteRun).toHaveBeenCalledTimes(1)
    expect(indexDb.deleteRun).toHaveBeenCalledTimes(1)
    expect(dataDb.rows).toEqual([
      {
        name: 'Stage',
        type: 'select',
        options: JSON.stringify([{ value: 'Idea', color: 'sky' }]),
        defaultValue: null,
        color: null,
        clock: null,
        syncedAt: null
      },
      {
        name: 'Status',
        type: 'status',
        options: JSON.stringify({ categories: statusCategories() }),
        defaultValue: null,
        color: null,
        clock: null,
        syncedAt: null
      }
    ])
    expect(indexDb.rows).toHaveLength(2)
  })

  it('carries a definition clock across the rebuild a reload triggers', async () => {
    safeReadMock.mockResolvedValue(
      propertiesFile(`  Stage:
    type: select
    options:
      - value: Idea
        color: sky
`)
    )
    const service = PropertyDefinitionsService.init('/vault')
    await service.reload()

    // The clock the sync handler would have stamped on the row.
    dataDb.rows[0].clock = { deviceA: 3 }
    dataDb.rows[0].syncedAt = '2026-09-01T00:00:00.000Z'

    await service.reload()

    // Dropping it here makes every definition look unclocked, and the next sync
    // re-pushes the whole set through `seedUnclocked` as creates.
    expect(dataDb.rows[0].clock).toEqual({ deviceA: 3 })
    expect(dataDb.rows[0].syncedAt).toBe('2026-09-01T00:00:00.000Z')
    // The index DB is a rebuildable cache and has no clock to keep.
    expect(indexDb.rows[0].clock).toBeNull()
  })

  it('unions a synced definition the file does not know about, and writes it back', async () => {
    // The file a freshly linked device has: none at all. Its first pull can
    // land definitions before anything on this device writes one.
    safeReadMock.mockResolvedValue(null)
    dataDb.rows.push({
      name: 'Area',
      type: 'select',
      options: JSON.stringify([{ value: 'Work', color: 'indigo' }]),
      defaultValue: null,
      color: null,
      clock: { deviceB: 1 },
      syncedAt: '2026-09-01T00:00:00.000Z'
    })

    const service = PropertyDefinitionsService.init('/vault')
    await service.reload()

    // Without the union, the reload the pull triggers rebuilds the table from
    // the file alone and deletes the definition that just arrived.
    expect(service.get('Area')).toEqual({
      name: 'Area',
      type: 'select',
      options: [{ value: 'Work', color: 'indigo' }]
    })
    expect(atomicWriteMock).toHaveBeenCalledWith(
      '/vault/.memry/properties.md',
      expect.stringContaining('Area')
    )
    expect(dataDb.rows.find((row) => row.name === 'Area')?.clock).toEqual({ deviceB: 1 })
  })

  it('drops a definition a peer deleted so the file cannot read it back in', async () => {
    safeReadMock.mockResolvedValue(
      propertiesFile(`  Stage:
    type: select
    options:
      - value: Idea
        color: sky
`)
    )
    const service = PropertyDefinitionsService.init('/vault')
    await service.reload()

    await service.applyRemoteDelete('Stage')

    expect(service.get('Stage')).toBeUndefined()
    expect(atomicWriteMock).toHaveBeenLastCalledWith(
      '/vault/.memry/properties.md',
      expect.not.stringContaining('Stage')
    )
  })

  it('queues a push for a local definition edit but never for a pulled one', async () => {
    safeReadMock.mockResolvedValue(null)
    const service = PropertyDefinitionsService.init('/vault')
    await service.reload()
    expect(enqueueUpsertMock).not.toHaveBeenCalled()

    await service.upsert({ name: 'Stage', type: 'select', options: [] })
    expect(enqueueUpsertMock).toHaveBeenCalledWith('Stage')

    await service.remove('Stage')
    expect(enqueueDeleteMock).toHaveBeenCalledWith('Stage', null)
  })

  it('keeps the last-known-good cache when reload sees invalid frontmatter or parse errors', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({
      name: 'Stage',
      type: 'select',
      options: [{ value: 'Idea', color: 'sky' }]
    })

    safeReadMock.mockResolvedValueOnce('---\nproperties: nope\n---\n')
    await service.reload()

    expect(service.getAll()).toEqual([
      { name: 'Stage', type: 'select', options: [{ value: 'Idea', color: 'sky' }] }
    ])

    safeReadMock.mockResolvedValueOnce('---\nproperties:\n  Broken: [')
    await service.reload()

    expect(service.get('Stage')?.options).toEqual([{ value: 'Idea', color: 'sky' }])
  })

  it('clears memory and DB caches when properties.md is missing', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({
      name: 'Stage',
      type: 'select',
      options: [{ value: 'Idea', color: 'sky' }]
    })

    safeReadMock.mockResolvedValueOnce(null)
    await service.reload()

    expect(service.getAll()).toEqual([])
    expect(dataDb.deleteRun).toHaveBeenCalledTimes(2)
    expect(indexDb.deleteRun).toHaveBeenCalledTimes(2)
    expect(dataDb.rows).toEqual([])
    expect(indexDb.rows).toEqual([])
  })

  it('persists upsert and remove changes back to properties.md', async () => {
    const service = PropertyDefinitionsService.init('/vault')

    await service.upsert({
      name: 'Stage',
      type: 'select',
      defaultValue: 'Idea',
      options: [{ value: 'Idea', color: 'sky' }]
    })
    await service.remove('Stage')

    expect(atomicWriteMock).toHaveBeenNthCalledWith(
      1,
      '/vault/.memry/properties.md',
      expect.stringContaining('type: select')
    )
    expect(atomicWriteMock).toHaveBeenNthCalledWith(
      2,
      '/vault/.memry/properties.md',
      expect.stringContaining('properties: {}')
    )
    expect(service.getAll()).toEqual([])
  })

  it('mutates select and status options', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    const newOption: SelectOption = { value: 'Review', color: 'violet' }

    await service.upsert({
      name: 'Stage',
      type: 'select',
      options: [{ value: 'Idea', color: 'sky' }]
    })
    await service.addOption('Stage', newOption)
    await service.renameOption('Stage', 'Idea', 'Draft')
    await service.updateOptionColor('Stage', 'Draft', 'amber')
    await service.removeOption('Stage', 'Review')

    expect(service.get('Stage')?.options).toEqual([{ value: 'Draft', color: 'amber' }])

    await service.upsert({
      name: 'Status',
      type: 'status',
      categories: statusCategories()
    })
    await service.addStatusOption('Status', 'done', { value: 'Archived', color: 'zinc' })
    await service.renameOption('Status', 'Backlog', 'Queued')
    await service.updateOptionColor('Status', 'Queued', 'blue')
    await service.removeOption('Status', 'Working')

    expect(service.get('Status')).toMatchObject({
      categories: {
        todo: { options: [{ value: 'Queued', color: 'blue', default: true }] },
        in_progress: { options: [] },
        done: {
          options: [
            { value: 'Shipped', color: 'emerald' },
            { value: 'Archived', color: 'zinc' }
          ]
        }
      }
    })
  })

  it('round-trips a project definition through properties.md', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'project', type: 'project' })

    const writtenContent = atomicWriteMock.mock.calls[0][1] as string
    safeReadMock.mockResolvedValueOnce(writtenContent)

    const reloaded = PropertyDefinitionsService.init('/vault')
    await reloaded.reload()

    expect(reloaded.get('project')).toEqual({
      name: 'project',
      type: 'project',
      options: undefined
    })
  })

  it('serializes queued writes and exports the shared default status definition', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    const writes: string[] = []
    atomicWriteMock.mockImplementation(async (_path: string, content: string) => {
      writes.push(content)
    })

    await Promise.all([
      service.upsert({ name: 'Stage', type: 'select', options: [{ value: 'Idea', color: 'sky' }] }),
      service.upsert({
        name: 'Priority',
        type: 'multiselect',
        options: [{ value: 'High', color: 'rose' }]
      })
    ])

    expect(writes).toHaveLength(2)
    expect(
      service
        .getAll()
        .map((def) => def.name)
        .sort()
    ).toEqual(['Priority', 'Stage'])
    expect(DEFAULT_STATUS_DEFINITION.type).toBe('status')
  })
})

describe('PropertyDefinitionsService — showOnCalendar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    PropertyDefinitionsService.destroy()
    getMemryDirMock.mockReturnValue('/vault/.memry')
    getDatabaseMock.mockReturnValue(
      (() => {
        const db = {
          delete: vi.fn(() => ({ run: vi.fn() })),
          insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) }))
        }
        return db
      })()
    )
    getIndexDatabaseMock.mockReturnValue(
      (() => {
        const db = {
          delete: vi.fn(() => ({ run: vi.fn() })),
          insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) }))
        }
        return db
      })()
    )
    safeReadMock.mockResolvedValue(null)
    atomicWriteMock.mockResolvedValue(undefined)
  })

  it('enables, persists, reloads, and disables a date property flag', async () => {
    const svc = PropertyDefinitionsService.init('/vault')
    expect(svc.listCalendarEnabledNames()).toEqual([])

    await svc.setShowOnCalendar('Deadline', true)
    expect(svc.listCalendarEnabledNames()).toEqual(['Deadline'])

    // Simulate reload from persisted file: atomicWrite captured the yaml, feed it back via safeRead
    const writtenContent = atomicWriteMock.mock.calls[0][1] as string
    safeReadMock.mockResolvedValueOnce(writtenContent)
    await svc.reload()
    expect(svc.listCalendarEnabledNames()).toEqual(['Deadline'])

    await svc.setShowOnCalendar('Deadline', false)
    expect(svc.listCalendarEnabledNames()).toEqual([])

    const writtenContent2 = atomicWriteMock.mock.calls.at(-1)![1] as string
    safeReadMock.mockResolvedValueOnce(writtenContent2)
    await svc.reload()
    expect(svc.listCalendarEnabledNames()).toEqual([])
  })

  it('keeps other enabled properties when one is toggled off', async () => {
    const svc = PropertyDefinitionsService.init('/vault')
    await svc.setShowOnCalendar('Deadline', true)
    await svc.setShowOnCalendar('Published', true)
    expect(svc.listCalendarEnabledNames().sort()).toEqual(['Deadline', 'Published'])

    await svc.setShowOnCalendar('Deadline', false)
    expect(svc.listCalendarEnabledNames()).toEqual(['Published'])

    const writtenContent = atomicWriteMock.mock.calls.at(-1)![1] as string
    safeReadMock.mockResolvedValueOnce(writtenContent)
    await svc.reload()
    expect(svc.listCalendarEnabledNames()).toEqual(['Published'])
  })
})

describe('PropertyDefinitionsService — option writes never vanish', () => {
  let dataDb: ReturnType<typeof createDbMock>
  let indexDb: ReturnType<typeof createDbMock>

  beforeEach(() => {
    vi.clearAllMocks()
    PropertyDefinitionsService.destroy()
    dataDb = createDbMock()
    indexDb = createDbMock()
    getMemryDirMock.mockReturnValue('/vault/.memry')
    getDatabaseMock.mockReturnValue(dataDb.db)
    getIndexDatabaseMock.mockReturnValue(indexDb.db)
    safeReadMock.mockResolvedValue(null)
    atomicWriteMock.mockResolvedValue(undefined)
  })

  // notes:create-property-definition sends exactly this shape for a status
  // property: no `categories`. js-yaml refuses to dump `undefined`, so the
  // write threw, the cache kept the unserializable definition, and every later
  // addStatusOption saw `!def.categories` and returned silently.
  it('persists a status definition created without categories', async () => {
    const service = PropertyDefinitionsService.init('/vault')

    await service.upsert({ name: 'Workflow', type: 'status' })

    expect(service.get('Workflow')?.categories).toEqual(DEFAULT_STATUS_DEFINITION.categories)
    expect(atomicWriteMock).toHaveBeenCalledWith(
      '/vault/.memry/properties.md',
      expect.stringContaining('Not started')
    )
  })

  it('round-trips a status definition created without categories through properties.md', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Workflow', type: 'status' })

    const written = atomicWriteMock.mock.calls.at(-1)![1] as string
    safeReadMock.mockResolvedValueOnce(written)

    const reloaded = PropertyDefinitionsService.init('/vault')
    await reloaded.reload()

    expect(reloaded.get('Workflow')?.categories).toEqual(DEFAULT_STATUS_DEFINITION.categories)
  })

  it('keeps persisting unrelated definitions after a status property is created', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({
      name: 'Stage',
      type: 'select',
      options: [{ value: 'Idea', color: 'sky' }]
    })
    await service.upsert({ name: 'Workflow', type: 'status' })

    await service.upsert({
      name: 'Area',
      type: 'select',
      options: [{ value: 'Ops', color: 'sky' }]
    })

    expect(atomicWriteMock.mock.calls.at(-1)![1] as string).toContain('Ops')
  })

  it('serializes a select definition that carries no options', async () => {
    const service = PropertyDefinitionsService.init('/vault')

    await service.upsert({ name: 'Stage', type: 'select' })

    expect(atomicWriteMock).toHaveBeenCalledWith(
      '/vault/.memry/properties.md',
      expect.stringContaining('type: select')
    )
  })

  it('adds a status option to a property that has no persisted definition', async () => {
    const service = PropertyDefinitionsService.init('/vault')

    await service.addStatusOption('Status', 'in_progress', { value: 'Blocked', color: 'amber' })

    expect(service.get('Status')?.categories?.in_progress.options).toEqual([
      { value: 'In Progress', color: 'amber' },
      { value: 'Blocked', color: 'amber' }
    ])
    expect(atomicWriteMock.mock.calls.at(-1)![1] as string).toContain('Blocked')
  })

  it('adds a status option to a definition stored without categories', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Workflow', type: 'status' })

    await service.addStatusOption('Workflow', 'todo', { value: 'Blocked', color: 'amber' })

    expect(service.get('Workflow')?.categories?.todo.options).toEqual([
      { value: 'Not started', color: 'stone', default: true },
      { value: 'Blocked', color: 'amber' }
    ])
  })

  it('keeps one entry when the same status option value is added twice', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Status', type: 'status', categories: statusCategories() })

    await service.addStatusOption('Status', 'in_progress', { value: 'Blocked', color: 'amber' })
    await service.addStatusOption('Status', 'in_progress', { value: 'Blocked', color: 'rose' })

    expect(service.get('Status')?.categories?.in_progress.options).toEqual([
      { value: 'Working', color: 'amber' },
      { value: 'Blocked', color: 'amber' }
    ])
  })

  it('keeps one entry when the same select option value is added twice', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Stage', type: 'select', options: [] })

    await service.addOption('Stage', { value: 'Idea', color: 'sky' })
    await service.addOption('Stage', { value: 'Idea', color: 'rose' })

    expect(service.get('Stage')?.options).toEqual([{ value: 'Idea', color: 'sky' }])
  })

  it('rejects an option mutation against a definition that does not exist', async () => {
    const service = PropertyDefinitionsService.init('/vault')

    await expect(
      service.addOption('missing', { value: 'Review', color: 'violet' })
    ).rejects.toThrow(/missing/)
    await expect(service.removeOption('missing', 'Review')).rejects.toThrow(/missing/)
    await expect(service.renameOption('missing', 'Review', 'Done')).rejects.toThrow(/missing/)
    await expect(service.updateOptionColor('missing', 'Review', 'sky')).rejects.toThrow(/missing/)
    expect(atomicWriteMock).not.toHaveBeenCalled()
  })

  it('rejects a status option added to a definition of another type', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Status', type: 'select', options: [] })

    await expect(
      service.addStatusOption('Status', 'todo', { value: 'Blocked', color: 'amber' })
    ).rejects.toThrow(/Status/)
  })

  it('rejects a status option added to an unknown category', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    await service.upsert({ name: 'Status', type: 'status', categories: statusCategories() })

    await expect(
      service.addStatusOption('Status', 'nope', { value: 'Blocked', color: 'amber' })
    ).rejects.toThrow(/nope/)
  })
})
