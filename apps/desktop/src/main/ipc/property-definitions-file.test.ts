import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import matter from 'gray-matter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesChannels } from '@memry/contracts/notes-api'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  dataDb: null as TestDatabaseResult | null,
  indexDb: null as TestDatabaseResult | null
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
      state.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => state.handlers.delete(channel)
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => tmpdir() },
  net: {}
}))

vi.mock('../database', () => ({
  getDatabase: () => state.dataDb!.db,
  getIndexDatabase: () => state.indexDb!.db
}))

vi.mock('../vault/property-definition-sync-effects', () => ({
  enqueuePropertyDefinitionUpsert: vi.fn(),
  enqueuePropertyDefinitionDelete: vi.fn(),
  readPropertyDefinitionRow: vi.fn(() => null)
}))

import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'
import { PropertyDefinitionsService } from '../vault/property-definitions'

const invoke = (channel: string, input?: unknown): Promise<unknown> => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`missing handler for ${channel}`)
  return Promise.resolve(handler({}, input))
}

describe('property definitions reach .memry/properties.md', () => {
  let vaultPath: string
  let filePath: string

  const fileProperties = (): unknown =>
    (matter(readFileSync(filePath, 'utf8')).data as { properties: unknown }).properties

  beforeEach(async () => {
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-property-definitions-'))
    mkdirSync(path.join(vaultPath, '.memry'))
    filePath = path.join(vaultPath, '.memry', 'properties.md')
    state.dataDb = createTestDataDb()
    state.indexDb = createTestIndexDb()
    await PropertyDefinitionsService.init(vaultPath).reload()
    registerNotesHandlers()
  })

  afterEach(() => {
    unregisterNotesHandlers()
    state.handlers.clear()
    PropertyDefinitionsService.destroy()
    state.dataDb?.close()
    state.indexDb?.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('writes text and date definitions to the file in the create call', async () => {
    await invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, { name: 'Source', type: 'text' })
    await invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, { name: 'Due', type: 'date' })

    expect(fileProperties()).toEqual({
      Source: { type: 'text', options: [] },
      Due: { type: 'date', showOnCalendar: false }
    })
  })

  it('lists the options the file holds after an update that names no type', async () => {
    const options = [{ value: 'Draft', color: 'gray' }]
    await invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, {
      name: 'Stage',
      type: 'select',
      options
    })
    await invoke(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION, {
      name: 'Stage',
      defaultValue: 'Draft'
    })

    const listed = (await invoke(NotesChannels.invoke.GET_PROPERTY_DEFINITIONS)) as Array<{
      name: string
      options: string | null
    }>
    expect(listed.map(({ name, options }) => ({ name, options }))).toEqual([
      { name: 'Stage', options: JSON.stringify(options) }
    ])
    expect(fileProperties()).toEqual({ Stage: { type: 'select', options } })
  })

  it('updates a definition that note indexing wrote only to the database', async () => {
    state
      .dataDb!.db.insert(propertyDefinitions)
      .values({ name: 'area', type: 'text', options: null, defaultValue: null, color: null })
      .run()

    const result = await invoke(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION, {
      name: 'area',
      type: 'select',
      options: [{ value: 'Work', color: 'blue' }]
    })

    expect(result).toMatchObject({ success: true, definition: { name: 'area', type: 'select' } })
    expect(fileProperties()).toEqual({
      area: { type: 'select', options: [{ value: 'Work', color: 'blue' }] }
    })
  })

  it('backfills database-only definitions once without touching file entries', async () => {
    writeFileSync(
      filePath,
      matter.stringify('', {
        properties: { Stage: { type: 'select', options: [{ value: 'Draft', color: 'gray' }] } }
      })
    )
    state
      .dataDb!.db.insert(propertyDefinitions)
      .values([
        { name: 'Rating', type: 'number', options: null, defaultValue: null, color: null },
        { name: 'Stage', type: 'text', options: null, defaultValue: null, color: null }
      ])
      .run()

    await PropertyDefinitionsService.get().reloadOnOpen()

    expect(fileProperties()).toEqual({
      Stage: { type: 'select', options: [{ value: 'Draft', color: 'gray' }] },
      Rating: { type: 'number', options: [] }
    })

    state
      .dataDb!.db.insert(propertyDefinitions)
      .values({ name: 'Mood', type: 'text', options: null, defaultValue: null, color: null })
      .run()
    await PropertyDefinitionsService.get().reloadOnOpen()

    expect(Object.keys(fileProperties() as object)).toEqual(['Stage', 'Rating'])
  })
})
