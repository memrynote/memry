/**
 * Adding a header tag whose schema names a template, through the note command.
 *
 * Real here: the note command and file writer, the index and data databases,
 * the templates service, tag schema resolution, and the markdown converter.
 * Stood in for: the CRDT provider's doc map (docs held by the test), the
 * external feed (a plain replace of a held doc), and the sync queue.
 */
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  docs: new Map<string, unknown>(),
  userData: ''
}))

vi.mock('electron', () => ({
  // The store reads its config under userData: an empty dir, so no vault is current.
  app: { getPath: () => state.userData },
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

vi.mock('../sync/crdt-external-feed', async () => {
  const { replaceNoteBodyInCrdt } = await import('../sync/crdt-feed')
  return {
    feedExternalEditToCrdt: (noteId: string, markdown: string) =>
      replaceNoteBodyInCrdt(noteId, markdown)
  }
})

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))

import * as vaultIndex from '../vault/index'
import { createNote } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'
import { createTemplate } from '../vault/templates'
import { markdownToYFragment } from '../sync/blocknote-converter'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { undoTagTemplateCommand, updateNoteWithTagTemplateCommand } from './domain'

const TEMPLATE_BODY = '## Agenda\n\nNotes go here\n'

describe('a header tag with a template', () => {
  let vault: TestVaultResult
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let templateId: string

  beforeEach(async () => {
    vault = createTestVault('tag-template')
    data = createTestDataDb()
    index = createTestIndexDb()
    state.userData = path.join(vault.path, '.user-data')
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
    templateId = (
      await createTemplate({ name: 'Meeting', tags: [], properties: [], content: TEMPLATE_BODY })
    ).id
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    data.close()
    index.close()
    vault.cleanup()
  })

  function defineTag(name: string, autofill: boolean): void {
    const schema = JSON.stringify({
      t: 1,
      fields: [{ name: 'Role' }],
      template: { id: templateId, autofill }
    })
    data.sqlite
      .prepare('INSERT INTO tag_definitions (name, color, schema) VALUES (?, ?, ?)')
      .run(name, 'stone', schema)
  }

  function fileBody(notePath: string): string {
    return parseNote(fs.readFileSync(path.join(vault.path, notePath), 'utf-8')).content
  }

  async function openDoc(noteId: string, body: string, notePath: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    if (body) {
      expect(
        await markdownToYFragment(body, doc.getXmlFragment(CRDT_FRAGMENT_NAME), notePath)
      ).toBe(true)
    }
    state.docs.set(noteId, doc)
    return doc
  }

  async function newNote(content: string): Promise<{ id: string; path: string }> {
    const note = await createNote({ title: 'Standup', content })
    await flushProjectionEvents()
    return note
  }

  it('fills an empty body when the tag autofills, and undo empties it again', async () => {
    defineTag('meeting', true)
    const note = await newNote('  \n')

    const result = await updateNoteWithTagTemplateCommand({
      id: note.id,
      headerTags: { add: ['meeting'] }
    })

    expect(result.tagTemplate).toMatchObject({ kind: 'applied', tag: 'meeting' })
    expect(fileBody(note.path)).toContain('Notes go here')
    expect(
      parseNote(fs.readFileSync(path.join(vault.path, note.path), 'utf-8')).frontmatter.tags
    ).toEqual(['meeting'])

    const undoToken = result.tagTemplate?.kind === 'applied' ? result.tagTemplate.undoToken : ''
    expect(await undoTagTemplateCommand({ noteId: note.id, undoToken })).toEqual({
      status: 'restored'
    })
    expect(fileBody(note.path).trim()).toBe('')
    // A token is spent once.
    expect(await undoTagTemplateCommand({ noteId: note.id, undoToken })).toEqual({
      status: 'stale'
    })
  })

  it('offers instead of filling a body that has text, and leaves it alone', async () => {
    defineTag('meeting', true)
    const note = await newNote('My own words')

    const result = await updateNoteWithTagTemplateCommand({
      id: note.id,
      headerTags: { add: ['meeting'] }
    })

    expect(result.tagTemplate).toEqual({ kind: 'offered', tag: 'meeting' })
    expect(fileBody(note.path).trim()).toBe('My own words')
  })

  it('offers instead of filling when the tag does not autofill', async () => {
    defineTag('meeting', false)
    const note = await newNote('')

    const result = await updateNoteWithTagTemplateCommand({
      id: note.id,
      headerTags: { add: ['plain', 'meeting'] }
    })

    expect(result.tagTemplate).toEqual({ kind: 'offered', tag: 'meeting' })
    expect(fileBody(note.path).trim()).toBe('')
  })

  it('reads an open editor body and refuses to undo once it was edited', async () => {
    defineTag('meeting', true)
    const note = await newNote('')
    const doc = await openDoc(note.id, '', note.path)

    const result = await updateNoteWithTagTemplateCommand({
      id: note.id,
      headerTags: { add: ['meeting'] }
    })
    expect(result.tagTemplate?.kind).toBe('applied')

    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.transact(() => fragment.delete(0, fragment.length))
    await markdownToYFragment(`${TEMPLATE_BODY}\nAction items`, fragment, note.path)

    const undoToken = result.tagTemplate?.kind === 'applied' ? result.tagTemplate.undoToken : ''
    expect(await undoTagTemplateCommand({ noteId: note.id, undoToken })).toEqual({
      status: 'stale'
    })
    expect(fileBody(note.path)).toContain('Notes go here')
  })

  it('creates a note tagged with a templated tag from that template', async () => {
    defineTag('meeting', false)

    const note = await createNote({ title: 'Kickoff', tags: ['meeting'] })

    expect(fileBody(note.path)).toContain('Notes go here')
  })

  it('keeps a tag the template body mentions out of the header, and undo keeps the header', async () => {
    templateId = (
      await createTemplate({ name: 'Tagged', tags: [], properties: [], content: 'Ask #followup\n' })
    ).id
    defineTag('meeting', true)
    const note = await newNote('')
    const header = (): unknown =>
      parseNote(fs.readFileSync(path.join(vault.path, note.path), 'utf-8')).frontmatter.tags

    const result = await updateNoteWithTagTemplateCommand({
      id: note.id,
      headerTags: { add: ['meeting'] }
    })
    expect(result.tagTemplate?.kind).toBe('applied')
    expect(fileBody(note.path)).toContain('#followup')
    expect(header()).toEqual(['meeting'])

    const undoToken = result.tagTemplate?.kind === 'applied' ? result.tagTemplate.undoToken : ''
    expect(await undoTagTemplateCommand({ noteId: note.id, undoToken })).toEqual({
      status: 'restored'
    })
    expect(header()).toEqual(['meeting'])
  })
})
