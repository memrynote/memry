/**
 * A header tag added while the note is open has to survive the next body save.
 *
 * Write-back writes the open doc's `tags` array over the file's `tags:` list
 * whenever the array is not empty, and opening or creating a note with tags
 * fills that array. So the note command must hand every header edit to the doc,
 * and only the header: an inline `#tag` that reached the array would be written
 * into the header by the next save.
 *
 * Real here: the note command and file writer, the index and data databases,
 * the projections, the markdown converter and the write-back. Stood in for: the
 * CRDT provider's doc map (one doc, held by the test) and the sync queue.
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
  docs: new Map<string, unknown>()
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

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))

import * as vaultIndex from '../vault/index'
import { createNote } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment } from '../sync/blocknote-converter'
import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  resetWritebackState,
  scheduleWriteback
} from '../sync/crdt-writeback'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { updateNoteCommand } from './domain'

describe('a header tag added to an open note', () => {
  let vault: TestVaultResult
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('header-tags-writeback')
    data = createTestDataDb()
    index = createTestIndexDb()
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

  /** The doc an editor holds after opening the note: the file's body and header tags. */
  async function openDoc(noteId: string, body: string, notePath: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    expect(await markdownToYFragment(body, doc.getXmlFragment(CRDT_FRAGMENT_NAME), notePath)).toBe(
      true
    )
    doc.getArray<string>('tags').push(['alpha'])
    state.docs.set(noteId, doc)
    return doc
  }

  async function typeBody(doc: Y.Doc, markdown: string, notePath: string): Promise<void> {
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.transact(() => fragment.delete(0, fragment.length))
    expect(await markdownToYFragment(markdown, fragment, notePath)).toBe(true)
  }

  it('reaches the doc as the header alone and stays in the file after the next save', async () => {
    const note = await createNote({
      title: 'Open Note',
      content: 'Body with #idea',
      tags: ['alpha']
    })
    await flushProjectionEvents()
    const doc = await openDoc(note.id, note.content, note.path)

    await updateNoteCommand({ id: note.id, headerTags: { add: ['beta'] } })
    await flushProjectionEvents()

    expect(doc.getArray<string>('tags').toArray()).toEqual(['alpha', 'beta'])

    await typeBody(doc, 'Body with #idea\n\nMore text', note.path)
    scheduleWriteback(note.id, doc, 'local')
    await flushPendingWritebacks()

    const raw = fs.readFileSync(path.join(vault.path, note.path), 'utf-8')
    expect(raw).toContain('More text')
    expect(parseNote(raw).frontmatter.tags).toEqual(['alpha', 'beta'])
  })

  it('reaches the doc when a saved body adds a plain #tag, and stays after the next save', async () => {
    const note = await createNote({ title: 'Agent Body', content: 'Body', tags: ['alpha'] })
    await flushProjectionEvents()
    const doc = await openDoc(note.id, note.content, note.path)

    await updateNoteCommand({ id: note.id, content: 'Body with #car' })
    await flushProjectionEvents()

    expect(doc.getArray<string>('tags').toArray()).toEqual(['alpha', 'car'])

    await typeBody(doc, 'Body with #car\n\nMore text', note.path)
    scheduleWriteback(note.id, doc, 'local')
    await flushPendingWritebacks()

    const raw = fs.readFileSync(path.join(vault.path, note.path), 'utf-8')
    expect(raw).toContain('More text')
    expect(parseNote(raw).frontmatter.tags).toEqual(['alpha', 'car'])
  })
})
