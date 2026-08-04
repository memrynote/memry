import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectOption, StatusCategories } from '@memry/contracts/property-types'

const { atomicWriteMock, safeReadMock, getMemryDirMock, getDatabaseMock, getIndexDatabaseMock } =
  vi.hoisted(() => ({
    atomicWriteMock: vi.fn(),
    safeReadMock: vi.fn(),
    getMemryDirMock: vi.fn(),
    getDatabaseMock: vi.fn(),
    getIndexDatabaseMock: vi.fn()
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

import { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } from './property-definitions'

type DbRow = {
  name: string
  type: string
  options: string | null
  defaultValue: string | null
  color: string | null
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
  return {
    rows,
    deleteRun,
    values,
    db: {
      delete: vi.fn(() => ({ run: deleteRun })),
      insert: vi.fn(() => ({ values }))
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
        color: null
      },
      {
        name: 'Status',
        type: 'status',
        options: JSON.stringify({ categories: statusCategories() }),
        defaultValue: null,
        color: null
      }
    ])
    expect(indexDb.rows).toHaveLength(2)
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

  it('mutates select and status options without touching missing definitions', async () => {
    const service = PropertyDefinitionsService.init('/vault')
    const newOption: SelectOption = { value: 'Review', color: 'violet' }

    await service.addOption('missing', newOption)
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
    await service.addStatusOption('Status', 'missing', { value: 'Ignored', color: 'red' })

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
