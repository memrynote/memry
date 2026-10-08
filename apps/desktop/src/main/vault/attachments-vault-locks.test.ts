/**
 * Attachment writes against read-only locks (#2606). Attachments live in
 * `attachments/<noteId>/`, outside the note's folder, so a folder lock only
 * reaches them through the owning note's path. Upload, delete and rename of a
 * locked note's attachment are refused with the lock text and the bytes on
 * disk stay as they were.
 *
 * @module vault/attachments-vault-locks.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn().mockResolvedValue('') }
}))

let vaultPath = ''
const notePaths: Record<string, string> = {
  'note-own-lock': 'notes/own.md',
  'note-in-locked-folder': 'locked/inside.md',
  'note-free': 'notes/free.md'
}

vi.mock('./index', () => ({ getStatus: () => ({ path: vaultPath, isOpen: true }) }))
vi.mock('./notes-io', () => ({ getVaultRoot: () => vaultPath }))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}) }))
vi.mock('../database/queries/notes/note-crud', () => ({
  getNoteCacheById: (_db: unknown, id: string) =>
    notePaths[id] ? { path: notePaths[id] } : undefined
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) =>
    notePaths[id] ? { path: notePaths[id] } : undefined
}))
vi.mock('./attachment-reference-scan', () => ({
  findNotesReferencingAttachment: () => ({ referencedBy: [], complete: true })
}))

import { deleteAttachment, saveAttachment } from './attachments'
import { renameAttachment } from './attachment-rename'
import { installVaultLockSource, invalidateVaultLocks } from '../vault-locks/registry'
import { writeLockRow } from '../vault-locks/store'

const STORED = 'abc123def456-photo.png'
const BYTES = 'original-bytes'

function attachmentPath(noteId: string, filename = STORED): string {
  return path.join(vaultPath, 'attachments', noteId, filename)
}

function filesOf(noteId: string): string[] {
  return fs.readdirSync(path.join(vaultPath, 'attachments', noteId)).sort()
}

describe('attachment writes of a locked note are refused (#2606)', () => {
  let data: TestDatabaseResult

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-locks-'))
    for (const noteId of Object.keys(notePaths)) {
      fs.mkdirSync(path.dirname(attachmentPath(noteId)), { recursive: true })
      fs.writeFileSync(attachmentPath(noteId), BYTES)
    }
    data = createTestDataDb()
    installVaultLockSource({
      dataDb: () => asClientDb(data.db),
      notePathOf: (noteId) => notePaths[noteId] ?? null,
      noteIdAtPath: (relativePath) =>
        Object.keys(notePaths).find((id) => notePaths[id] === relativePath) ?? null
    })
    writeLockRow(asClientDb(data.db), 'note', 'note-own-lock', true)
    writeLockRow(asClientDb(data.db), 'folder', 'locked', true)
    invalidateVaultLocks()
  })

  afterEach(() => {
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    data.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  const lockedNotes = ['note-own-lock', 'note-in-locked-folder']

  it.each(lockedNotes)(
    'delete of an attachment of %s is refused and the file stays',
    async (id) => {
      await expect(deleteAttachment(id, STORED)).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

      expect(fs.readFileSync(attachmentPath(id), 'utf8')).toBe(BYTES)
    }
  )

  it.each(lockedNotes)('upload to %s is refused and writes nothing', async (id) => {
    const result = await saveAttachment(id, Buffer.from('new-bytes'), 'new.png')

    expect(result).toEqual({ success: false, error: VAULT_LOCKED_NOTE_MESSAGE })
    expect(filesOf(id)).toEqual([STORED])
  })

  it.each(lockedNotes)(
    'rename of an attachment of %s is refused and the file stays',
    async (id) => {
      await expect(
        renameAttachment(id, `../attachments/${id}/${STORED}`, 'renamed')
      ).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)

      expect(filesOf(id)).toEqual([STORED])
      expect(fs.readFileSync(attachmentPath(id), 'utf8')).toBe(BYTES)
    }
  )

  it('a free note still uploads, renames and deletes its attachments', async () => {
    const saved = await saveAttachment('note-free', Buffer.from('new-bytes'), 'new.png')
    expect(saved.success).toBe(true)
    expect(filesOf('note-free')).toHaveLength(2)

    const renamed = await renameAttachment(
      'note-free',
      `../attachments/note-free/${STORED}`,
      'renamed'
    )
    expect(renamed.storedFilename).not.toBe(STORED)

    await expect(deleteAttachment('note-free', renamed.storedFilename)).resolves.toEqual({
      deleted: true,
      referencedBy: []
    })
  })
})
