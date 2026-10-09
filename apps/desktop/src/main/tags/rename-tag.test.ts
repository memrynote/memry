/**
 * A tag rename carries its `/` children, rewrites body `#tags` (closed notes
 * through the note command, open notes inside their live doc, journals too),
 * and merges into a name that already exists.
 *
 * Real here: the note command and file writer, the index and data databases,
 * the projections, the markdown converter, the write-back and the task retag.
 * Stood in for: the CRDT provider's doc map (held by the test), the sync queue
 * and the journal's sync/CRDT seeding.
 */
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import type { DataDb } from '../database/types'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  seedInboxProject,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  docs: new Map<string, unknown>()
}))

const sync = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/client')>()),
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))

vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: () => ({
    getDoc: (noteId: string) => state.docs.get(noteId),
    recordOwedFullState: vi.fn(),
    purge: vi.fn(async () => {})
  })
}))

vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../sync/local-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/local-mutations')>()),
  ...sync
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {})
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import * as vaultIndex from '../vault/index'
import { createNote } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment } from '../sync/blocknote-converter'
import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  resetWritebackState
} from '../sync/crdt-writeback'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { getNoteTags } from '@main/database/queries/notes'
import {
  getOrCreateTag,
  updateTagColor,
  writeTagSchemaColumn
} from '@main/database/queries/tag-definitions'
import { getTaskTags, insertTask, setTaskTags } from '@main/database/queries/tasks'
import { createJournalEntry } from '../journal/create-entry'
import { renameTagEverywhere } from './rename-tag'

describe('renameTagEverywhere', () => {
  let vault: TestVaultResult
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let dataDb: DataDb

  beforeEach(() => {
    vault = createTestVault('rename-tag')
    data = createTestDataDb()
    index = createTestIndexDb()
    dataDb = asClientDb(data.db)
    state.data = data.db
    state.index = index.db
    state.docs.clear()
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
  })

  afterEach(async () => {
    cancelPendingWritebacks()
    resetWritebackState()
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    data.close()
    index.close()
    vault.cleanup()
  })

  const read = (notePath: string) =>
    parseNote(fs.readFileSync(path.join(vault.path, notePath), 'utf-8'))

  const rename = async (from: string, to: string): Promise<number> => {
    const touched = await renameTagEverywhere(index.db, dataDb, from, to)
    await flushPendingWritebacks()
    await flushProjectionEvents()
    return touched
  }

  const tag = (name: string, color: string): void => {
    getOrCreateTag(dataDb, name)
    updateTagColor(dataDb, name, color)
  }

  const definition = (name: string) =>
    dataDb.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()

  it('renames the tag and its children in headers, bodies, tasks, definitions and references', async () => {
    const note = await createNote({
      title: 'Closed',
      content: 'Met #person and #Person/VIP, not #personal. `#person` stays.',
      tags: ['person', 'person/vip', 'work']
    })
    const taskProject = seedInboxProject(data.db)
    insertTask(dataDb, { id: 'task-1', projectId: taskProject, title: 'Call', position: 0 })
    setTaskTags(dataDb, 'task-1', ['person/vip', 'work'])
    tag('person', 'rose')
    dataDb
      .update(tagDefinitions)
      .set({ views: '[{"id":"v1"}]', icon: '👤' })
      .where(eq(tagDefinitions.name, 'person'))
      .run()
    writeTagSchemaColumn(dataDb, 'person', '{"v":1,"t":1,"fields":[]}')
    tag('person/vip', 'amber')
    tag('company', 'sky')
    writeTagSchemaColumn(
      dataDb,
      'company',
      JSON.stringify({
        v: 1,
        t: 4,
        extends: 'person/vip',
        fields: [{ id: 'f1', name: 'Owner', type: 'relation', relation: { target: 'person' } }]
      })
    )
    await flushProjectionEvents()

    expect(await rename('person', 'people')).toBe(1)

    const file = read(note.path)
    expect(file.frontmatter.tags).toEqual(['people', 'people/vip', 'work'])
    expect(file.content).toContain('Met #people and #people/VIP, not #personal. `#person` stays.')
    expect(getNoteTags(index.db, note.id).map((t) => t.toLowerCase())).toEqual(
      expect.arrayContaining(['people', 'people/vip', 'work'])
    )
    expect(getTaskTags(dataDb, 'task-1').map((t) => t.toLowerCase())).toEqual(
      expect.arrayContaining(['people/vip', 'work'])
    )
    expect(definition('person')).toBeUndefined()
    expect(definition('person/vip')).toBeUndefined()
    expect(definition('people')).toMatchObject({
      color: 'rose',
      icon: '👤',
      views: '[{"id":"v1"}]',
      schema: '{"v":1,"t":1,"fields":[]}'
    })
    expect(definition('people/vip')).toMatchObject({ color: 'amber' })
    const company = JSON.parse(definition('company')?.schema ?? '{}')
    expect(company.extends).toBe('people/vip')
    expect(company.fields[0].relation.target).toBe('people')
    expect(sync.enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'tag_definition',
      'person/vip',
      expect.any(String)
    )
    expect(sync.enqueueLocalSyncCreate).toHaveBeenCalledWith('tag_definition', 'people/vip')
  })

  it('renames body tags of an open note inside its live doc', async () => {
    const note = await createNote({
      title: 'Open',
      content: 'Hello #person/vip and #personal',
      tags: ['person/vip']
    })
    await flushProjectionEvents()
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    expect(await markdownToYFragment(note.content, fragment, note.path)).toBe(true)
    // A chip the editor made from a typed `#person`, next to the text one.
    const paragraph = fragment
      .createTreeWalker((node) => node instanceof Y.XmlElement && node.nodeName === 'paragraph')
      .next().value as Y.XmlElement
    const chip = new Y.XmlElement('hashTag')
    chip.setAttribute('tag', 'person')
    paragraph.push([chip])
    doc.getArray<string>('tags').push(['person/vip'])
    state.docs.set(note.id, doc)

    await rename('person', 'people')

    expect(chip.getAttribute('tag')).toBe('people')
    expect(fragment.toString()).toContain('#people/vip and #personal')
    const file = read(note.path)
    expect(file.frontmatter.tags).toEqual(['people/vip'])
    expect(file.content).toContain('#people/vip and #personal')
    expect(file.content).toContain('#people')
    expect(file.content).not.toMatch(/#person\b(?!al)/)
  })

  it('rewrites a journal body', async () => {
    await createJournalEntry({ date: '2026-03-01', content: 'Lunch with #person', tags: [] })
    await flushProjectionEvents()

    expect(await rename('person', 'people')).toBe(1)

    const raw = fs.readFileSync(path.join(vault.path, 'journal', '2026-03-01.md'), 'utf-8')
    expect(raw).toContain('Lunch with #people')
  })

  it('merges into a name that already exists, parent and children', async () => {
    const both = await createNote({
      title: 'Both',
      content: 'Body #person/vip',
      tags: ['person', 'people', 'person/vip']
    })
    tag('person', 'rose')
    tag('people', 'teal')
    writeTagSchemaColumn(dataDb, 'people', '{"v":1,"t":2,"fields":[]}')
    await flushProjectionEvents()

    await rename('person', 'people')

    const file = read(both.path)
    expect(file.frontmatter.tags).toEqual(['people', 'people/vip'])
    expect(file.content).toContain('Body #people/vip')
    expect(definition('person')).toBeUndefined()
    expect(definition('people')).toMatchObject({
      color: 'teal',
      schema: '{"v":1,"t":2,"fields":[]}'
    })
    expect(
      getNoteTags(index.db, both.id)
        .map((t) => t.toLowerCase())
        .sort()
    ).toEqual(['people', 'people/vip'])
  })
})
