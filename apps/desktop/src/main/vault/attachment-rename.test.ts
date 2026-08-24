/**
 * Tests for attachment-rename.ts (#1714). The disk rename is the half of the
 * feature the note body cannot repair on its own, so the name shaping, the
 * collision walk and the "this note's folder only" guard are all covered here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn().mockResolvedValue('') }
}))

const getNoteCacheById = vi.fn()
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => getNoteCacheById(...args)
}))

vi.mock('../database', () => ({ getIndexDatabase: () => ({}) }))
vi.mock('../database/queries/notes/note-crud', () => ({
  getNoteCacheById: (...args: unknown[]) => getNoteCacheById(...args)
}))

let vaultPath = ''
vi.mock('./notes-io', () => ({ getVaultRoot: () => vaultPath }))
vi.mock('./index', () => ({ getStatus: () => ({ path: vaultPath }) }))

import {
  buildRenamedFilename,
  renameAttachment,
  resolveCollision,
  sanitizeAttachmentName
} from './attachment-rename'
import { NoteError } from '../lib/errors'

const NOTE_ID = 'n1'
const NOTE_PATH = 'notes/My Note.md'

function writeAttachment(relative: string): string {
  const absolute = path.join(vaultPath, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, 'pdf-bytes')
  return absolute
}

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-rename-'))
  getNoteCacheById.mockImplementation((_db: unknown, id: string) =>
    id === NOTE_ID ? { path: NOTE_PATH } : undefined
  )
})

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('buildRenamedFilename', () => {
  it('keeps the nanoid prefix and the extension', () => {
    expect(buildRenamedFilename('k3f9x2-scan_0031.pdf', 'Invoice March')).toBe(
      'k3f9x2-Invoice-March.pdf'
    )
  })

  it('does not duplicate an extension the user typed', () => {
    expect(buildRenamedFilename('k3f9x2-scan.pdf', 'invoice.pdf')).toBe('k3f9x2-invoice.pdf')
    expect(buildRenamedFilename('k3f9x2-scan.pdf', 'invoice.PDF')).toBe('k3f9x2-invoice.pdf')
  })

  it('strips what would break a markdown link or the file marker', () => {
    expect(buildRenamedFilename('k3f9x2-a.png', 'holiday (2) {draft}')).toBe(
      'k3f9x2-holiday-2-draft.png'
    )
  })

  it('never produces an empty middle segment', () => {
    // sanitizeFilename already answers a name that is nothing but dots.
    expect(buildRenamedFilename('k3f9x2-a.png', '...')).toBe('k3f9x2-untitled.png')
    expect(buildRenamedFilename('k3f9x2-a.png', '( )')).toBe('k3f9x2-file.png')
  })

  it('leaves a prefix-less legacy filename prefix-less', () => {
    expect(buildRenamedFilename('report.pdf', 'invoice')).toBe('invoice.pdf')
  })

  it('sanitizes path separators out of the name', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).not.toContain('/')
  })
})

describe('resolveCollision', () => {
  it('returns the candidate when nothing holds the name', () => {
    fs.mkdirSync(path.join(vaultPath, 'attachments', NOTE_ID), { recursive: true })
    expect(resolveCollision(path.join(vaultPath, 'attachments', NOTE_ID), 'a-b.pdf')).toBe(
      'a-b.pdf'
    )
  })

  it('walks -2, -3 while the name is taken', () => {
    const dir = path.join(vaultPath, 'attachments', NOTE_ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'k3f9x2-invoice.pdf'), 'x')
    fs.writeFileSync(path.join(dir, 'k3f9x2-invoice-2.pdf'), 'x')

    expect(resolveCollision(dir, 'k3f9x2-invoice.pdf')).toBe('k3f9x2-invoice-3.pdf')
  })
})

describe('renameAttachment', () => {
  it('renames the file on disk and returns the new note-relative ref', async () => {
    writeAttachment(`attachments/${NOTE_ID}/k3f9x2-scan_0031.pdf`)

    const result = await renameAttachment(
      NOTE_ID,
      `../attachments/${NOTE_ID}/k3f9x2-scan_0031.pdf`,
      'Invoice March'
    )

    expect(result).toEqual({
      storedFilename: 'k3f9x2-Invoice-March.pdf',
      url: `../attachments/${NOTE_ID}/k3f9x2-Invoice-March.pdf`,
      name: 'Invoice March.pdf'
    })
    expect(
      fs.existsSync(path.join(vaultPath, 'attachments', NOTE_ID, 'k3f9x2-Invoice-March.pdf'))
    ).toBe(true)
    expect(
      fs.existsSync(path.join(vaultPath, 'attachments', NOTE_ID, 'k3f9x2-scan_0031.pdf'))
    ).toBe(false)
  })

  it('renames the file self-heal found when the block ref is stale', async () => {
    // The block still names the pre-external-rename file; only the healed one exists.
    writeAttachment(`attachments/${NOTE_ID}/k3f9x2-renamed-by-hand.pdf`)

    const result = await renameAttachment(
      NOTE_ID,
      `../attachments/${NOTE_ID}/k3f9x2-scan.pdf`,
      'invoice'
    )

    expect(result.storedFilename).toBe('k3f9x2-invoice.pdf')
    expect(fs.existsSync(path.join(vaultPath, 'attachments', NOTE_ID, 'k3f9x2-invoice.pdf'))).toBe(
      true
    )
  })

  it('suffixes instead of overwriting an existing file', async () => {
    // The nanoid prefix normally keeps two attachments apart; prefix-less
    // legacy files (and a freak prefix collision) are what can actually clash.
    writeAttachment(`attachments/${NOTE_ID}/one.pdf`)
    writeAttachment(`attachments/${NOTE_ID}/invoice.pdf`)

    const result = await renameAttachment(NOTE_ID, `../attachments/${NOTE_ID}/one.pdf`, 'invoice')

    expect(result.storedFilename).toBe('invoice-2.pdf')
    expect(
      fs.readFileSync(path.join(vaultPath, 'attachments', NOTE_ID, 'invoice.pdf'), 'utf8')
    ).toBe('pdf-bytes')
  })

  it('is a no-op when the submitted name is the one it already has', async () => {
    writeAttachment(`attachments/${NOTE_ID}/k3f9x2-invoice.pdf`)

    const result = await renameAttachment(
      NOTE_ID,
      `../attachments/${NOTE_ID}/k3f9x2-invoice.pdf`,
      'invoice.pdf'
    )

    // The file holding that name is this file — suffixing it would be churn.
    expect(result.storedFilename).toBe('k3f9x2-invoice.pdf')
    expect(fs.readdirSync(path.join(vaultPath, 'attachments', NOTE_ID))).toEqual([
      'k3f9x2-invoice.pdf'
    ])
  })

  it('rejects a file outside this note’s attachments folder', async () => {
    writeAttachment('attachments/other/k3f9x2-report.pdf')

    await expect(
      renameAttachment(NOTE_ID, '../attachments/other/k3f9x2-report.pdf', 'invoice')
    ).rejects.toBeInstanceOf(NoteError)
  })

  it('rejects a file that is not on disk', async () => {
    fs.mkdirSync(path.join(vaultPath, 'attachments', NOTE_ID), { recursive: true })

    await expect(
      renameAttachment(NOTE_ID, `../attachments/${NOTE_ID}/k3f9x2-gone.pdf`, 'invoice')
    ).rejects.toBeInstanceOf(NoteError)
  })

  it('rejects an empty name before touching the disk', async () => {
    writeAttachment(`attachments/${NOTE_ID}/k3f9x2-scan.pdf`)

    await expect(
      renameAttachment(NOTE_ID, `../attachments/${NOTE_ID}/k3f9x2-scan.pdf`, '   ')
    ).rejects.toBeInstanceOf(NoteError)
    expect(fs.existsSync(path.join(vaultPath, 'attachments', NOTE_ID, 'k3f9x2-scan.pdf'))).toBe(
      true
    )
  })
})
