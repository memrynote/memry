/**
 * Tests for attachment-references.ts (#2077) — the "insert existing attachment"
 * seam. The ref it hands back is the whole relationship, so what matters is
 * that it names the OWNING note's folder from the RECEIVING note's directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildExistingAttachmentReference,
  displayNameForStoredFilename,
  listVaultAttachments
} from './attachment-references'

const state = vi.hoisted(() => ({
  vaultPath: '',
  rows: [] as { id: string; path: string; title: string }[]
}))

vi.mock('./notes-io', () => ({
  getVaultRoot: () => {
    if (!state.vaultPath) throw new Error('No vault is open')
    return state.vaultPath
  }
}))

vi.mock('./index', () => ({
  getStatus: () => ({ path: state.vaultPath, isOpen: true })
}))

vi.mock('../database', () => ({
  getIndexDatabase: () => ({})
}))

vi.mock('@main/database/queries/notes', () => ({
  getAllNoteRefRows: () => state.rows,
  getNoteCacheById: (_db: unknown, id: string) => state.rows.find((row) => row.id === id)
}))

function writeAttachment(ownerNoteId: string, filename: string, body = 'bytes'): void {
  const dir = path.join(state.vaultPath, 'attachments', ownerNoteId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), body)
}

describe('displayNameForStoredFilename', () => {
  it('drops the nanoid prefix and leaves anything else alone', () => {
    expect(displayNameForStoredFilename('k3f9x2-report.pdf')).toBe('report.pdf')
    expect(displayNameForStoredFilename('report.pdf')).toBe('report.pdf')
  })
})

describe('attachment references', () => {
  beforeEach(() => {
    state.vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-references-'))
    state.rows = [
      { id: 'note-a', path: 'notes/A.md', title: 'Invoices' },
      { id: 'note-b', path: 'notes/archive/2026/B.md', title: 'Archive' }
    ]
  })

  afterEach(() => {
    fs.rmSync(state.vaultPath, { recursive: true, force: true })
    state.vaultPath = ''
  })

  describe('listVaultAttachments', () => {
    it('lists attachments from every note folder with the owning note title', () => {
      writeAttachment('note-a', 'k3f9x2-report.pdf')
      writeAttachment('note-b', 'aaaaaa-photo.png')

      const entries = listVaultAttachments()

      expect(entries.map((e) => [e.ownerNoteId, e.displayName, e.ownerNoteTitle, e.type])).toEqual(
        expect.arrayContaining([
          ['note-a', 'report.pdf', 'Invoices', 'file'],
          ['note-b', 'photo.png', 'Archive', 'image']
        ])
      )
    })

    it('keeps a folder whose note is no longer indexed, with no title', () => {
      writeAttachment('orphan-note', 'k3f9x2-report.pdf')

      expect(listVaultAttachments()).toEqual([
        expect.objectContaining({ ownerNoteId: 'orphan-note', ownerNoteTitle: null })
      ])
    })

    it('skips dotfiles and extensions no block can render', () => {
      writeAttachment('note-a', '.DS_Store')
      writeAttachment('note-a', 'k3f9x2-notes.sqlite')
      writeAttachment('note-a', 'k3f9x2-report.pdf')

      expect(listVaultAttachments().map((e) => e.filename)).toEqual(['k3f9x2-report.pdf'])
    })

    it('is empty when the vault has no attachments folder', () => {
      expect(listVaultAttachments()).toEqual([])
    })
  })

  describe('buildExistingAttachmentReference', () => {
    it('points a note in a deeper folder at the owning note’s stored file', () => {
      writeAttachment('note-a', 'k3f9x2-report.pdf')

      const result = buildExistingAttachmentReference('note-b', 'note-a', 'k3f9x2-report.pdf')

      expect(result).toEqual({
        url: '../../../attachments/note-a/k3f9x2-report.pdf',
        name: 'report.pdf',
        filename: 'k3f9x2-report.pdf',
        ownerNoteId: 'note-a',
        size: 5,
        mimeType: 'application/pdf',
        type: 'file'
      })
    })

    it('copies nothing: the bytes stay in the owning note’s folder only', () => {
      writeAttachment('note-a', 'k3f9x2-report.pdf')

      buildExistingAttachmentReference('note-b', 'note-a', 'k3f9x2-report.pdf')

      expect(fs.existsSync(path.join(state.vaultPath, 'attachments', 'note-b'))).toBe(false)
      expect(fs.readdirSync(path.join(state.vaultPath, 'attachments', 'note-a'))).toEqual([
        'k3f9x2-report.pdf'
      ])
    })

    it('is an ordinary local ref when a note references its own attachment', () => {
      writeAttachment('note-a', 'k3f9x2-report.pdf')

      expect(buildExistingAttachmentReference('note-a', 'note-a', 'k3f9x2-report.pdf').url).toBe(
        '../attachments/note-a/k3f9x2-report.pdf'
      )
    })

    it('refuses a traversal in either identifier', () => {
      writeAttachment('note-a', 'k3f9x2-report.pdf')

      expect(() => buildExistingAttachmentReference('note-b', '../..', 'x.pdf')).toThrow()
      expect(() =>
        buildExistingAttachmentReference('note-b', 'note-a', '../note-a/k3f9x2-report.pdf')
      ).toThrow()
    })

    it('refuses a file that is not on disk, and an unknown receiving note', () => {
      expect(() =>
        buildExistingAttachmentReference('note-b', 'note-a', 'k3f9x2-report.pdf')
      ).toThrow()

      writeAttachment('note-a', 'k3f9x2-report.pdf')
      expect(() =>
        buildExistingAttachmentReference('missing-note', 'note-a', 'k3f9x2-report.pdf')
      ).toThrow()
    })
  })
})
