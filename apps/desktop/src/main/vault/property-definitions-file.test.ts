import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import matter from 'gray-matter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabases } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  dbs: null as ReturnType<typeof createTestDatabases> | null,
  warn: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: () => state.dbs!.data.db,
  getIndexDatabase: () => state.dbs!.index.db
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: state.warn, error: vi.fn() })
}))
vi.mock('./property-definition-sync-effects', () => ({
  enqueuePropertyDefinitionUpsert: vi.fn(),
  enqueuePropertyDefinitionDelete: vi.fn(),
  readPropertyDefinitionRow: vi.fn(() => null)
}))

import { PropertyDefinitionsService } from './property-definitions'

const FILE_WITH_ONE_BAD_ENTRY = `---
properties:
  Stage:
    type: select
    options:
      - value: Idea
        color: sky
  Broken:
    type: select
    options: not-a-list
  Rating:
    type: stars
    max: 5
  Due:
    type: date
    showOnCalendar: true
---
`

describe('properties.md with one bad entry', () => {
  let vaultPath: string
  let filePath: string

  beforeEach(async () => {
    state.dbs = createTestDatabases()
    state.warn.mockClear()
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-propdefs-'))
    await fs.mkdir(path.join(vaultPath, '.memry'))
    filePath = path.join(vaultPath, '.memry', 'properties.md')
    await fs.writeFile(filePath, FILE_WITH_ONE_BAD_ENTRY)
  })

  afterEach(async () => {
    PropertyDefinitionsService.destroy()
    state.dbs!.closeAll()
    await fs.rm(vaultPath, { recursive: true, force: true })
  })

  it('loads the valid definitions, names the bad ones, and keeps them through a rewrite', async () => {
    const service = PropertyDefinitionsService.init(vaultPath)
    expect(await service.reload()).toBe(true)

    expect(service.getAll().map((def) => def.name)).toEqual(['Stage', 'Due'])
    const warned = state.warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(warned).toContain('Broken')
    expect(warned).toContain('Rating')

    await service.upsert({ name: 'Area', type: 'select', options: [] })

    const written = matter(await fs.readFile(filePath, 'utf-8')).data.properties
    expect(Object.keys(written).sort()).toEqual(['Area', 'Broken', 'Due', 'Rating', 'Stage'])
    expect(written.Broken).toEqual({ type: 'select', options: 'not-a-list' })
    expect(written.Rating).toEqual({ type: 'stars', max: 5 })
  })

  it('a valid definition saved under a bad entry name replaces it', async () => {
    const service = PropertyDefinitionsService.init(vaultPath)
    await service.reload()
    await service.upsert({ name: 'Broken', type: 'select', options: [] })

    const written = matter(await fs.readFile(filePath, 'utf-8')).data.properties
    expect(written.Broken).toEqual({ type: 'select', options: [] })
  })

  it('never rewrites a file it could not read at all', async () => {
    const unreadable = '---\nproperties: [\n---\n'
    await fs.writeFile(filePath, unreadable)
    const service = PropertyDefinitionsService.init(vaultPath)
    expect(await service.reload()).toBe(false)

    await service.upsert({ name: 'Area', type: 'select', options: [] })

    expect(await fs.readFile(filePath, 'utf-8')).toBe(unreadable)
  })
})
