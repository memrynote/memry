import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tasks } from '@memry/db-schema/schema/tasks'
import { plainVersionedMap } from '@memry/shared/versioned'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  locked: new Set<string>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../database/client')>()),
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))
vi.mock('../../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: () => ({ getDoc: () => undefined, recordOwedFullState: vi.fn() })
}))
vi.mock('../../vault-locks/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vault-locks/registry')>()),
  isNoteLocked: (noteId: string) => state.locked.has(noteId)
}))
vi.mock('../../notes/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notes/runtime-effects')>()),
  syncNoteUpdate: vi.fn()
}))

import * as vaultIndex from '../../vault/index'
import { createNote } from '../../vault/notes'
import { parseNote } from '../../vault/frontmatter'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import { getSetting } from '@main/database/queries/settings'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { runTagSchemaCommand } from './commands'
import { FIELD_RENAME_JOB_SETTING, renameField, resumeFieldRename } from './field-rename'

let vault: TestVaultResult
let data: TestDatabaseResult
let index: TestDatabaseResult

const db = () => asClientDb(data.db)

beforeEach(async () => {
  vault = createTestVault('field-rename')
  data = createTestDataDb()
  index = createTestIndexDb()
  state.data = data.db
  state.index = index.db
  state.locked.clear()
  vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
    isOpen: true,
    path: vault.path,
    isIndexing: false,
    indexProgress: 100,
    error: null
  } satisfies VaultStatus)
  vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  } satisfies VaultConfig)
  startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  const queue = new SyncQueueManager(asSyncDb(data.db))
  initTagDefinitionSyncService({ queue, db: asSyncDb(data.db), getDeviceId: () => 'device-a' })
  initTaskSyncService({ queue, db: db(), getDeviceId: () => 'device-a' })
  PropertyDefinitionsService.init(vault.path)
  await PropertyDefinitionsService.get().reloadOnOpen()
})

afterEach(async () => {
  await stopProjectionRuntime()
  resetTaskSyncService()
  resetTagDefinitionSyncService()
  PropertyDefinitionsService.destroy()
  vi.restoreAllMocks()
  data.close()
  index.close()
  vault.cleanup()
})

async function noteWith(title: string, properties: Record<string, unknown>) {
  const note = await createNote({ title, content: 'Body', tags: ['person'], properties })
  await flushProjectionEvents()
  return note
}

const frontmatter = (notePath: string): Record<string, unknown> =>
  parseNote(fs.readFileSync(path.join(vault.path, notePath), 'utf-8')).frontmatter as Record<
    string,
    unknown
  >

async function taskWithPhone(value: string): Promise<string> {
  data.db
    .insert(projects)
    .values({ id: 'proj-1', name: 'P', color: '#000' })
    .onConflictDoNothing()
    .run()
  const domain = createDesktopTasksDomain(db(), {} as TasksDomainPublisher, () => 'task-1')
  const created = await domain.createTask({
    projectId: 'proj-1',
    title: 'Call back',
    priority: 0,
    fields: { Phone: value }
  })
  if (!created.task) throw new Error('task not created')
  return created.task.id
}

describe('renaming a field everywhere', () => {
  it('survives a crash after the first note and finishes on the next run without duplicates', async () => {
    await runTagSchemaCommand(
      db(),
      index.db as never,
      { kind: 'add-field', tag: 'person', field: { name: 'Phone', type: 'text' } },
      () => {}
    )
    const first = await noteWith('Ahmet', { Role: 'PM', Phone: '111' })
    const second = await noteWith('Elif', { Phone: '222', Email: 'e@x.io' })
    const already = await noteWith('Can', { Phone: '333', Mobile: '999' })
    const taskId = await taskWithPhone('444')

    let seen = 0
    await expect(
      renameField(db(), { from: 'Phone', to: 'Mobile', runId: 'r1' }, () => {
        seen += 1
        if (seen === 1) throw new Error('app quit')
      })
    ).rejects.toThrow('app quit')
    await flushProjectionEvents()
    expect(JSON.parse(getSetting(db(), FIELD_RENAME_JOB_SETTING)!)).toMatchObject({
      from: 'Phone',
      to: 'Mobile'
    })

    const result = await resumeFieldRename(db())
    await flushProjectionEvents()

    expect(getSetting(db(), FIELD_RENAME_JOB_SETTING)).toBeNull()
    expect(result).toMatchObject({ tasks: 1, skippedExisting: 1 })
    const keys = Object.keys(frontmatter(first.path))
    expect(keys.indexOf('Mobile')).toBe(keys.indexOf('Role') + 1)
    expect(frontmatter(first.path)).toMatchObject({ Role: 'PM', Mobile: '111' })
    expect(frontmatter(first.path)).not.toHaveProperty('Phone')
    expect(frontmatter(second.path)).toMatchObject({ Mobile: '222', Email: 'e@x.io' })
    expect(frontmatter(second.path)).not.toHaveProperty('Phone')
    expect(frontmatter(already.path)).toMatchObject({ Phone: '333', Mobile: '999' })

    const stored = data.db
      .select({ fields: tasks.fields })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    expect(plainVersionedMap(stored?.fields)).toEqual({ Mobile: '444' })

    const schema = data.db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, 'person'))
      .get()
    expect(JSON.parse(schema!.schema!).fields).toEqual([{ name: 'Mobile' }])
    expect(PropertyDefinitionsService.get().get('Phone')).toBeUndefined()
    expect(PropertyDefinitionsService.get().get('Mobile')).toMatchObject({ type: 'text' })
  })

  async function personWithPhone(): Promise<void> {
    await runTagSchemaCommand(
      db(),
      index.db as never,
      { kind: 'add-field', tag: 'person', field: { name: 'Phone', type: 'text' } },
      () => {}
    )
  }

  it('refuses a rename onto a field the same tag already lists, and changes nothing', async () => {
    await personWithPhone()
    await runTagSchemaCommand(
      db(),
      index.db as never,
      { kind: 'add-field', tag: 'person', field: { name: 'Mobile', type: 'text' } },
      () => {}
    )
    const note = await noteWith('Ahmet', { Phone: '111' })

    await expect(
      renameField(db(), { from: 'Phone', to: 'Mobile', runId: 'r1' }, () => {})
    ).rejects.toThrow(/already has a field named "Mobile"/)
    expect(frontmatter(note.path)).toMatchObject({ Phone: '111' })
    expect(getSetting(db(), FIELD_RENAME_JOB_SETTING)).toBeNull()
  })

  it('keeps the job for a locked note and finishes it once the note is unlocked', async () => {
    await personWithPhone()
    const open = await noteWith('Ahmet', { Phone: '111' })
    const locked = await noteWith('Elif', { Phone: '222' })
    state.locked.add(locked.id)

    const result = await renameField(db(), { from: 'Phone', to: 'Mobile', runId: 'r1' }, () => {})
    await flushProjectionEvents()

    expect(result).toMatchObject({ notes: 1, skippedLocked: 1 })
    expect(frontmatter(open.path)).toMatchObject({ Mobile: '111' })
    expect(frontmatter(locked.path)).toMatchObject({ Phone: '222' })
    expect(getSetting(db(), FIELD_RENAME_JOB_SETTING)).not.toBeNull()
    await expect(
      renameField(db(), { from: 'Role', to: 'Title', runId: 'r2' }, () => {})
    ).rejects.toThrow(/Phone to Mobile/)

    state.locked.clear()
    expect(await resumeFieldRename(db())).toMatchObject({ notes: 1, skippedLocked: 0 })
    await flushProjectionEvents()
    expect(frontmatter(locked.path)).toMatchObject({ Mobile: '222' })
    expect(frontmatter(locked.path)).not.toHaveProperty('Phone')
    expect(getSetting(db(), FIELD_RENAME_JOB_SETTING)).toBeNull()
  })

  it('renames a field to a new spelling of the same name', async () => {
    await personWithPhone()
    const note = await noteWith('Ahmet', { Role: 'PM', Phone: '111' })

    const result = await renameField(db(), { from: 'Phone', to: 'phone', runId: 'r1' }, () => {})
    await flushProjectionEvents()

    expect(result).toMatchObject({ notes: 1, skippedExisting: 0 })
    expect(Object.keys(frontmatter(note.path))).toEqual(['tags', 'Role', 'phone'])
    expect(frontmatter(note.path)).toMatchObject({ phone: '111' })
  })
})
