/**
 * Tests for attachment-reference-scan.ts (#2077).
 *
 * The invariant under test is the one that protects user data: removing an
 * embed from one note must not delete a blob another note references.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  attachmentTargetFromAbsolutePath,
  findNotesReferencingAttachment,
  isAttachmentUnreferenced
} from './attachment-reference-scan'

const state = vi.hoisted(() => ({
  vaultPath: '',
  rows: [] as { id: string; path: string; title: string }[],
  throwOnRows: false
}))

vi.mock('./notes-io', () => ({
  getVaultRoot: () => {
    if (!state.vaultPath) throw new Error('No vault is open')
    return state.vaultPath
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: () => ({})
}))

vi.mock('@main/database/queries/notes', () => ({
  getAllNoteRefRows: () => {
    if (state.throwOnRows) throw new Error('index unavailable')
    return state.rows
  }
}))

function writeNote(relativePath: string, body: string): void {
  const absolute = path.join(state.vaultPath, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, body)
}

describe('attachmentTargetFromAbsolutePath', () => {
  it('reads the owner note and filename out of a vault attachment path', () => {
    expect(
      attachmentTargetFromAbsolutePath('/vault', '/vault/attachments/note-a/k3f9x2-report.pdf')
    ).toEqual({ ownerNoteId: 'note-a', filename: 'k3f9x2-report.pdf' })
  })

  it('rejects anything outside the attachments tree', () => {
    expect(attachmentTargetFromAbsolutePath('/vault', '/vault/notes/Foo.md')).toBeNull()
    expect(attachmentTargetFromAbsolutePath('/vault', '/elsewhere/attachments/a/b.pdf')).toBeNull()
    expect(
      attachmentTargetFromAbsolutePath('/vault', '/vault/attachments/note-a/nested/b.pdf')
    ).toBeNull()
  })
})

describe('findNotesReferencingAttachment', () => {
  beforeEach(() => {
    state.vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-ref-scan-'))
    state.rows = []
    state.throwOnRows = false
  })

  afterEach(() => {
    fs.rmSync(state.vaultPath, { recursive: true, force: true })
    state.vaultPath = ''
  })

  const target = { ownerNoteId: 'note-a', filename: 'k3f9x2-report.pdf' }

  it('finds a note-relative shared ref written by desktop', () => {
    writeNote('notes/B.md', '<!-- file:{"url":"../attachments/note-a/k3f9x2-report.pdf"} -->')
    state.rows = [{ id: 'note-b', path: 'notes/B.md', title: 'B' }]

    expect(findNotesReferencingAttachment(target)).toEqual({
      referencedBy: ['note-b'],
      complete: true
    })
  })

  it('finds a mobile root-relative ref and a legacy absolute one', () => {
    writeNote('notes/B.md', '![x](attachments/note-a/k3f9x2-report.pdf)')
    writeNote(
      'notes/C.md',
      '![x](memry-file://local/Users/someone/OtherVault/attachments/note-a/k3f9x2-report.pdf)'
    )
    state.rows = [
      { id: 'note-b', path: 'notes/B.md', title: 'B' },
      { id: 'note-c', path: 'notes/C.md', title: 'C' }
    ]

    expect(findNotesReferencingAttachment(target).referencedBy).toEqual(['note-b', 'note-c'])
  })

  it('finds a reference from a journal, which the paged note scans skip', () => {
    writeNote('journals/2026-09-11.md', '![x](../attachments/note-a/k3f9x2-report.pdf)')
    state.rows = [{ id: 'journal-1', path: 'journals/2026-09-11.md', title: '2026-09-11' }]

    expect(findNotesReferencingAttachment(target).referencedBy).toEqual(['journal-1'])
  })

  it('ignores a different file in the same folder and the same name elsewhere', () => {
    writeNote(
      'notes/B.md',
      [
        '![x](../attachments/note-a/aaaaaa-other.pdf)',
        '![y](../attachments/note-z/k3f9x2-report.pdf)'
      ].join('\n')
    )
    state.rows = [{ id: 'note-b', path: 'notes/B.md', title: 'B' }]

    expect(findNotesReferencingAttachment(target).referencedBy).toEqual([])
  })

  it('excludes the note that is asking', () => {
    writeNote('notes/A.md', '![x](../attachments/note-a/k3f9x2-report.pdf)')
    state.rows = [{ id: 'note-a', path: 'notes/A.md', title: 'A' }]

    expect(
      findNotesReferencingAttachment(target, { excludeNoteId: 'note-a' }).referencedBy
    ).toEqual([])
  })

  it('skips index rows whose file is gone rather than failing the scan', () => {
    state.rows = [{ id: 'ghost', path: 'notes/Gone.md', title: 'Gone' }]

    expect(findNotesReferencingAttachment(target)).toEqual({ referencedBy: [], complete: true })
  })

  it('reports an incomplete scan when the notes cannot be enumerated', () => {
    state.throwOnRows = true

    expect(findNotesReferencingAttachment(target)).toEqual({ referencedBy: [], complete: false })
  })
})

describe('isAttachmentUnreferenced', () => {
  beforeEach(() => {
    state.vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-ref-scan-'))
    state.rows = []
    state.throwOnRows = false
  })

  afterEach(() => {
    fs.rmSync(state.vaultPath, { recursive: true, force: true })
    state.vaultPath = ''
  })

  it('is false for a shared blob and false again when the scan cannot prove it', () => {
    writeNote('notes/B.md', '![x](../attachments/note-a/k3f9x2-report.pdf)')
    state.rows = [{ id: 'note-b', path: 'notes/B.md', title: 'B' }]
    expect(isAttachmentUnreferenced({ ownerNoteId: 'note-a', filename: 'k3f9x2-report.pdf' })).toBe(
      false
    )

    state.throwOnRows = true
    expect(isAttachmentUnreferenced({ ownerNoteId: 'note-a', filename: 'k3f9x2-report.pdf' })).toBe(
      false
    )
  })

  it('is true only when nothing references the blob', () => {
    state.rows = []
    expect(isAttachmentUnreferenced({ ownerNoteId: 'note-a', filename: 'k3f9x2-report.pdf' })).toBe(
      true
    )
  })
})
