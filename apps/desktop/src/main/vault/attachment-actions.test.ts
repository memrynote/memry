/**
 * Tests for attachment-actions.ts — resolve / reveal / open for attachment
 * blocks. The path validation here is the security boundary: a block url is
 * caller-supplied data and must never hand a path outside the vault to the OS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const showItemInFolder = vi.fn()
const openPath = vi.fn().mockResolvedValue('')

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: (...args: unknown[]) => showItemInFolder(...args),
    openPath: (...args: unknown[]) => openPath(...args)
  }
}))

const getNoteCacheById = vi.fn()
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => getNoteCacheById(...args)
}))

vi.mock('../database', () => ({
  getIndexDatabase: () => ({})
}))

let vaultPath = ''
vi.mock('./notes-io', () => ({
  getVaultRoot: () => vaultPath
}))

import {
  resolveAttachment,
  revealAttachmentInFinder,
  openAttachmentExternal
} from './attachment-actions'
import { NoteError, NoteErrorCode } from '../lib/errors'

const NOTE_ID = 'n1'
const NOTE_PATH = 'notes/My Note.md'

function writeAttachment(relative: string): string {
  const absolute = path.join(vaultPath, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, 'pdf-bytes')
  return absolute
}

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-actions-'))
  getNoteCacheById.mockImplementation((_db: unknown, id: string) =>
    id === NOTE_ID ? { path: NOTE_PATH } : undefined
  )
  showItemInFolder.mockClear()
  openPath.mockClear()
})

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('resolveAttachment', () => {
  it('resolves a note-relative ref to the on-disk path', () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-report.pdf')

    const result = resolveAttachment(NOTE_ID, '../attachments/n1/k3f9x2-report.pdf')

    expect(result).toEqual({
      absolutePath: absolute,
      storedFilename: 'k3f9x2-report.pdf',
      exists: true
    })
  })

  it('decodes percent-encoded refs', () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-my report.pdf')

    const result = resolveAttachment(NOTE_ID, '../attachments/n1/k3f9x2-my%20report.pdf')

    expect(result.absolutePath).toBe(absolute)
    expect(result.exists).toBe(true)
  })

  it('reports a missing file with exists: false and still names the stored file', () => {
    const result = resolveAttachment(NOTE_ID, '../attachments/n1/k3f9x2-late.pdf')

    expect(result.exists).toBe(false)
    expect(result.storedFilename).toBe('k3f9x2-late.pdf')
  })

  it('rejects a ref that escapes the vault', () => {
    expect(() => resolveAttachment(NOTE_ID, '../../../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: NoteErrorCode.INVALID_PATH })
    )
  })

  it('rejects non-vault urls (http, absolute filesystem paths)', () => {
    for (const url of ['https://example.com/x.pdf', '/etc/passwd', '\\\\server\\share\\x.pdf']) {
      expect(() => resolveAttachment(NOTE_ID, url)).toThrowError(
        expect.objectContaining({ code: NoteErrorCode.INVALID_PATH })
      )
    }
  })

  it('throws NOT_FOUND for an unknown note id', () => {
    expect(() => resolveAttachment('missing', '../attachments/n1/f.pdf')).toThrowError(NoteError)
    try {
      resolveAttachment('missing', '../attachments/n1/f.pdf')
    } catch (err) {
      expect((err as NoteError).code).toBe(NoteErrorCode.NOT_FOUND)
    }
  })

  it('accepts a legacy absolute memry-file url inside this vault', () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-old.pdf')
    const url = `memry-file://local${absolute}`

    const result = resolveAttachment(NOTE_ID, url)

    expect(result.absolutePath).toBe(absolute)
    expect(result.exists).toBe(true)
  })

  it('remaps a legacy absolute url written on another device', () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-remote.pdf')
    const url = 'memry-file://local/Users/other/OtherVault/attachments/n1/k3f9x2-remote.pdf'

    const result = resolveAttachment(NOTE_ID, url)

    expect(result.absolutePath).toBe(absolute)
    expect(result.exists).toBe(true)
  })

  it('falls back to the local candidate path for a cross-device url not yet synced', () => {
    const url = 'memry-file://local/Users/other/OtherVault/attachments/n1/k3f9x2-late.pdf'

    const result = resolveAttachment(NOTE_ID, url)

    expect(result.absolutePath).toBe(path.join(vaultPath, 'attachments', 'n1', 'k3f9x2-late.pdf'))
    expect(result.exists).toBe(false)
  })

  it('rejects a legacy url whose attachments tail traverses upward', () => {
    const url = 'memry-file://local/Users/other/vault/attachments/../../../etc/passwd'

    expect(() => resolveAttachment(NOTE_ID, url)).toThrowError(
      expect.objectContaining({ code: NoteErrorCode.INVALID_PATH })
    )
  })
})

describe('revealAttachmentInFinder', () => {
  it('shows the resolved file in the OS file manager', () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-report.pdf')

    revealAttachmentInFinder(NOTE_ID, '../attachments/n1/k3f9x2-report.pdf')

    expect(showItemInFolder).toHaveBeenCalledWith(absolute)
  })

  it('throws instead of revealing a file that is not on disk', () => {
    expect(() =>
      revealAttachmentInFinder(NOTE_ID, '../attachments/n1/k3f9x2-late.pdf')
    ).toThrowError(expect.objectContaining({ code: NoteErrorCode.NOT_FOUND }))
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('openAttachmentExternal', () => {
  it('opens the resolved file with the OS default app', async () => {
    const absolute = writeAttachment('attachments/n1/k3f9x2-report.pdf')

    await openAttachmentExternal(NOTE_ID, '../attachments/n1/k3f9x2-report.pdf')

    expect(openPath).toHaveBeenCalledWith(absolute)
  })

  it('throws instead of opening a file that is not on disk', async () => {
    await expect(
      openAttachmentExternal(NOTE_ID, '../attachments/n1/k3f9x2-late.pdf')
    ).rejects.toThrowError(expect.objectContaining({ code: NoteErrorCode.NOT_FOUND }))
    expect(openPath).not.toHaveBeenCalled()
  })
})
