import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { TagSchemaChannels } from '@memry/contracts/ipc-channels'
import type {
  ImpactResult,
  TagSchemaCommandResult,
  TagSchemaSnapshot
} from '@memry/contracts/tag-schema-api'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import {
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  send: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<typeof mockIpcMain.handle>[1]) =>
      mockIpcMain.handle(channel, handler),
    removeHandler: (channel: string) => mockIpcMain.removeHandler(channel)
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: state.send } }]
  }
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/client')>()),
  getDatabase: () => state.data,
  requireDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))

import { PropertyDefinitionsService } from '../vault/property-definitions'
import { registerTagSchemaHandlers, unregisterTagSchemaHandlers } from './tag-schema-handlers'

let vault: TestVaultResult
let data: TestDatabaseResult
let index: TestDatabaseResult

beforeEach(async () => {
  resetIpcMocks()
  state.send.mockClear()
  vault = createTestVault('tag-schema-ipc')
  data = createTestDataDb()
  index = createTestIndexDb()
  state.data = data.db
  state.index = index.db
  initTagDefinitionSyncService({
    queue: new SyncQueueManager(asSyncDb(data.db)),
    db: asSyncDb(data.db),
    getDeviceId: () => 'device-a'
  })
  PropertyDefinitionsService.init(vault.path)
  await PropertyDefinitionsService.get().reloadOnOpen()
  registerTagSchemaHandlers()
})

afterEach(() => {
  unregisterTagSchemaHandlers()
  resetTagDefinitionSyncService()
  PropertyDefinitionsService.destroy()
  data.close()
  index.close()
  vault.cleanup()
})

const edit = (command: unknown) =>
  invokeHandler<TagSchemaCommandResult>(TagSchemaChannels.invoke.EDIT_SCHEMA, command)

describe('tag schema IPC', () => {
  it('starts with an empty snapshot and shows a field once the renderer adds it', async () => {
    const before = await invokeHandler<TagSchemaSnapshot>(
      TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT
    )
    expect(before.tags).toEqual({})

    const result = await edit({
      kind: 'add-field',
      tag: 'Person',
      field: { name: 'Role', type: 'text' }
    })
    const after = await invokeHandler<TagSchemaSnapshot>(
      TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT
    )

    expect(result.snapshot.tags.person.effectiveFields).toMatchObject([
      { name: 'Role', type: 'text' }
    ])
    expect(after).toEqual(result.snapshot)
  })

  it('maps a header-tagged note to its object tag in the snapshot', async () => {
    await edit({ kind: 'add-field', tag: 'person', field: { name: 'Role', type: 'text' } })
    index.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, content_hash, created_at, modified_at)
      VALUES ('ahmet', 'notes/ahmet.md', 'Ahmet', 'markdown', 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    index.db.run(
      sql`INSERT INTO note_tags (note_id, tag, position, in_header) VALUES ('ahmet', 'person', 0, 1)`
    )

    const snapshot = await invokeHandler<TagSchemaSnapshot>(
      TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT
    )

    expect(snapshot.objects).toEqual({ ahmet: 'person' })
  })

  it('rejects a malformed schema command without changing anything', async () => {
    await expect(edit({ kind: 'add-field', tag: 'person' })).rejects.toThrow(/Validation failed/)
    await expect(edit({ kind: 'explode' })).rejects.toThrow(/Validation failed/)

    const snapshot = await invokeHandler<TagSchemaSnapshot>(
      TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT
    )
    expect(snapshot.tags).toEqual({})
  })

  it('broadcasts rename progress to every window under the run id', async () => {
    await edit({ kind: 'add-field', tag: 'person', field: { name: 'Phone', type: 'text' } })
    state.send.mockClear()

    const result = await edit({ kind: 'rename-field', from: 'Phone', to: 'Mobile', runId: 'run-1' })

    expect(result.rename).toMatchObject({ notes: 0, tasks: 0 })
    expect(result.snapshot.tags.person.effectiveFields.map((f) => f.name)).toEqual(['Mobile'])
    expect(state.send).toHaveBeenCalledWith(TagSchemaChannels.events.PROGRESS, {
      runId: 'run-1',
      done: 0,
      total: 0
    })
  })

  it('previews impact counts for a field before the renderer removes it', async () => {
    await edit({ kind: 'add-field', tag: 'person', field: { name: 'Role', type: 'text' } })
    index.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, content_hash, created_at, modified_at)
      VALUES ('ahmet', 'notes/ahmet.md', 'Ahmet', 'markdown', 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    index.db.run(
      sql`INSERT INTO note_tags (note_id, tag, position, in_header) VALUES ('ahmet', 'person', 0, 1)`
    )
    index.db.run(
      sql`INSERT INTO note_properties (note_id, name, value, type) VALUES ('ahmet', 'Role', 'PM', 'text')`
    )

    const impact = await invokeHandler<ImpactResult>(TagSchemaChannels.invoke.PREVIEW_IMPACT, {
      kind: 'remove-field',
      tag: 'person',
      name: 'Role'
    })

    expect(impact).toEqual({ kind: 'remove-field', filled: 1, empty: 0 })
  })

  it('rejects an impact query of an unknown kind', async () => {
    await expect(
      invokeHandler(TagSchemaChannels.invoke.PREVIEW_IMPACT, { kind: 'burn-it-down' })
    ).rejects.toThrow(/Validation failed/)
  })

  it('stops answering once unregistered', async () => {
    unregisterTagSchemaHandlers()

    await expect(invokeHandler(TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT)).rejects.toThrow(
      /No handler registered/
    )
  })
})
