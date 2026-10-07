import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PdfDocument } from '../../../../file-text/pdf-host'
import type { ViewImageSource } from '../../../../image-processing/protocol'
import { AgentToolError } from '../../errors'
import { ImageToolResult } from '../../tool-image'
import {
  VIEW_IMAGE_MAX_EDGE,
  viewVaultFile,
  type FileViewDeps,
  type FileViewRow
} from '../file-view'

const ROWS = {
  shot: { id: 'shot', path: 'Screens/login.png', title: 'login', fileType: 'image' },
  scan: { id: 'scan', path: 'Scans/contract.pdf', title: 'contract', fileType: 'pdf' },
  memo: { id: 'memo', path: 'Audio/memo.m4a', title: 'memo', fileType: 'audio' },
  note: { id: 'note', path: 'Notes/trip.md', title: 'Trip', fileType: 'markdown' },
  legacy: { id: 'legacy', path: 'Notes/old.md', title: 'Old', fileType: null }
} as const

let vault: string
let prepared: Array<{ source: ViewImageSource; maxEdge: number }>
let rendered: Array<{ page: number; maxEdge: number }>
let closed: number
let opened: Array<{ path: string; size: number }>

function pdf(pageCount: number): PdfDocument {
  return {
    pageCount,
    pageText: async () => '',
    renderPage: async (page, maxEdge) => {
      rendered.push({ page, maxEdge })
      return { png: new Uint8Array([1, 2, 3]), width: 1210, height: 1568 }
    },
    close: async () => {
      closed += 1
    }
  }
}

function deps(overrides: Partial<FileViewDeps> = {}): FileViewDeps {
  return {
    vaultPath: vault,
    fileRow: (id) => (ROWS as Record<string, FileViewRow>)[id],
    prepareImage: async (source, maxEdge) => {
      prepared.push({ source, maxEdge })
      return source.kind === 'png'
        ? {
            data: new Uint8Array([9, 9]),
            mimeType: 'image/png',
            width: 1210,
            height: 1568,
            sourceWidth: 1210,
            sourceHeight: 1568
          }
        : {
            data: new Uint8Array([7, 7, 7]),
            mimeType: 'image/png',
            width: 1568,
            height: 980,
            sourceWidth: 3136,
            sourceHeight: 1960
          }
    },
    openPdf: async (absolutePath, size) => {
      opened.push({ path: absolutePath, size })
      return pdf(3)
    },
    ...overrides
  }
}

function write(relative: string, bytes = 'x'): void {
  const file = path.join(vault, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

async function viewError(input: Parameters<typeof viewVaultFile>[1]): Promise<AgentToolError> {
  const error = await viewVaultFile(deps(), input).then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(AgentToolError)
  return error as AgentToolError
}

describe('viewVaultFile', () => {
  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-file-view-')))
    prepared = []
    rendered = []
    opened = []
    closed = 0
    write('Screens/login.png')
    write('Scans/contract.pdf', 'pdf-bytes')
    write('Audio/memo.m4a')
    write('Notes/trip.md', '![](attachments/note/photo.jpg)')
    write('attachments/note/photo.jpg')
    write('attachments/note/receipt.pdf', 'receipt')
    write('attachments/note/clip.mp3')
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(`${vault}-outside`, { recursive: true, force: true })
    fs.rmSync(`${vault}-link`, { force: true })
  })

  it('returns a filed image downscaled to 1568 px with what was sent', async () => {
    const result = await viewVaultFile(deps(), { id: 'shot' })

    expect(prepared).toEqual([
      {
        source: { kind: 'file', path: path.join(vault, 'Screens/login.png') },
        maxEdge: VIEW_IMAGE_MAX_EDGE
      }
    ])
    expect(VIEW_IMAGE_MAX_EDGE).toBe(1568)
    expect(result).toBeInstanceOf(ImageToolResult)
    expect(result.image).toEqual({
      data: Buffer.from([7, 7, 7]).toString('base64'),
      mimeType: 'image/png'
    })
    expect(result.reply).toEqual({
      id: 'shot',
      title: 'login',
      file: 'Screens/login.png',
      file_type: 'image',
      mime_type: 'image/png',
      width: 1568,
      height: 980,
      source_width: 3136,
      source_height: 1960,
      message:
        'The image follows as image content at 1568 x 980 px, downscaled from 3136 x 1960 px.'
    })
  })

  it('renders one PDF page through the PDF host and closes the document', async () => {
    const result = await viewVaultFile(deps(), { id: 'scan', page: 2 })

    expect(opened).toEqual([
      { path: path.join(vault, 'Scans/contract.pdf'), size: 'pdf-bytes'.length }
    ])
    expect(rendered).toEqual([{ page: 2, maxEdge: VIEW_IMAGE_MAX_EDGE }])
    expect(prepared).toEqual([
      { source: { kind: 'png', data: new Uint8Array([1, 2, 3]) }, maxEdge: VIEW_IMAGE_MAX_EDGE }
    ])
    expect(closed).toBe(1)
    expect(result.reply).toEqual({
      id: 'scan',
      title: 'contract',
      file: 'Scans/contract.pdf',
      file_type: 'pdf',
      page: 2,
      page_count: 3,
      mime_type: 'image/png',
      width: 1210,
      height: 1568,
      message: 'Page 2 of 3 follows as image content at 1210 x 1568 px.'
    })
  })

  it('shows page 1 of a PDF when no page is given', async () => {
    await viewVaultFile(deps(), { id: 'scan' })

    expect(rendered).toEqual([{ page: 1, maxEdge: VIEW_IMAGE_MAX_EDGE }])
  })

  it('refuses a page past the end and says how many pages there are', async () => {
    const error = await viewError({ id: 'scan', page: 4 })

    expect(error.code).toBe('VALIDATION')
    expect(error.message).toContain('has 3 pages')
    expect(error.details).toEqual({ id: 'scan', page: 4, page_count: 3 })
    expect(closed).toBe(1)
  })

  it('shows an image or PDF from a note attachments folder by file name', async () => {
    const image = await viewVaultFile(deps(), { id: 'note', attachment: 'photo.jpg' })
    const page = await viewVaultFile(deps(), { id: 'note', attachment: 'receipt.pdf' })

    expect(prepared[0]?.source).toEqual({
      kind: 'file',
      path: path.join(vault, 'attachments/note/photo.jpg')
    })
    expect(image.reply).toMatchObject({
      id: 'note',
      title: 'Trip',
      attachment: 'photo.jpg',
      file: 'attachments/note/photo.jpg',
      file_type: 'image'
    })
    expect(opened[0]?.path).toBe(path.join(vault, 'attachments/note/receipt.pdf'))
    expect(page.reply).toMatchObject({
      attachment: 'receipt.pdf',
      file: 'attachments/note/receipt.pdf',
      file_type: 'pdf',
      page: 1
    })
  })

  it('refuses attachment names that leave the note attachments folder', async () => {
    for (const attachment of [
      '../note/photo.jpg',
      'sub/photo.jpg',
      '..',
      '.hidden.png',
      'a\\b.png'
    ]) {
      const error = await viewError({ id: 'note', attachment })
      expect(error.code).toBe('VALIDATION')
    }
    expect(prepared).toEqual([])
  })

  it('reports a missing note, file or attachment as NOT_FOUND', async () => {
    expect((await viewError({ id: 'nope' })).code).toBe('NOT_FOUND')
    expect((await viewError({ id: 'note', attachment: 'gone.png' })).code).toBe('NOT_FOUND')
    fs.rmSync(path.join(vault, 'Screens/login.png'))
    expect((await viewError({ id: 'shot' })).code).toBe('NOT_FOUND')
  })

  it('refuses what it cannot show', async () => {
    const cases: Array<[Parameters<typeof viewVaultFile>[1], string]> = [
      [{ id: 'memo' }, 'filed audio file'],
      [{ id: 'note' }, 'markdown note'],
      [{ id: 'legacy' }, 'markdown note'],
      [{ id: 'note', attachment: 'clip.mp3' }, 'not an image or a PDF'],
      [{ id: 'shot', attachment: 'photo.jpg' }, 'markdown note'],
      [{ id: 'shot', page: 2 }, 'only for PDFs']
    ]
    for (const [input, text] of cases) {
      const error = await viewError(input)
      expect(error.code).toBe('VALIDATION')
      expect(error.message).toContain(text)
    }
  })

  it('reports an image the decoder cannot read as VALIDATION', async () => {
    const error = await viewVaultFile(
      deps({ prepareImage: vi.fn().mockRejectedValue(new Error('unsupported image format')) }),
      { id: 'shot' }
    ).catch((caught: unknown) => caught as AgentToolError)

    expect(error).toBeInstanceOf(AgentToolError)
    expect((error as AgentToolError).code).toBe('VALIDATION')
    expect((error as AgentToolError).message).toContain('unsupported image format')
  })

  it('reports a PDF that does not open as VALIDATION', async () => {
    const error = await viewVaultFile(
      deps({ openPdf: vi.fn().mockRejectedValue(new Error('Invalid PDF structure')) }),
      { id: 'scan' }
    ).catch((caught: unknown) => caught as AgentToolError)

    expect((error as AgentToolError).code).toBe('VALIDATION')
    expect((error as AgentToolError).message).toContain('Invalid PDF structure')
  })

  describe('symlinks', () => {
    function outsideFile(name: string): string {
      const file = path.join(`${vault}-outside`, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'secret')
      return file
    }

    function link(relative: string, target: string): void {
      fs.rmSync(path.join(vault, relative), { force: true })
      fs.symlinkSync(target, path.join(vault, relative))
    }

    it('refuses an attachment that links to a file outside the vault and reads nothing', async () => {
      link('attachments/note/p.pdf', outsideFile('private.pdf'))

      const error = await viewError({ id: 'note', attachment: 'p.pdf' })

      expect(error.code).toBe('PERMISSION_DENIED')
      expect(error.message).toBe(
        'attachments/note/p.pdf points outside the vault. vault_view_file reads only files inside the vault.'
      )
      expect(opened).toEqual([])
      expect(prepared).toEqual([])
    })

    it('refuses a filed file that links outside the vault', async () => {
      link('Screens/login.png', outsideFile('id_ed25519.png'))

      const error = await viewError({ id: 'shot' })

      expect(error.code).toBe('PERMISSION_DENIED')
      expect(error.message).toBe(
        'Screens/login.png points outside the vault. vault_view_file reads only files inside the vault.'
      )
      expect(prepared).toEqual([])
    })

    it('refuses a dangling link with the same error', async () => {
      link('attachments/note/gone.png', path.join(`${vault}-outside`, 'deleted.png'))

      const error = await viewError({ id: 'note', attachment: 'gone.png' })

      expect(error.code).toBe('PERMISSION_DENIED')
      expect(error.message).toBe(
        'attachments/note/gone.png points outside the vault. vault_view_file reads only files inside the vault.'
      )
      expect(prepared).toEqual([])
    })

    it('shows a link that stays inside the vault, read from its target', async () => {
      link('attachments/note/alias.png', path.join(vault, 'Screens/login.png'))

      const result = await viewVaultFile(deps(), { id: 'note', attachment: 'alias.png' })

      expect(prepared[0]?.source).toEqual({
        kind: 'file',
        path: path.join(vault, 'Screens/login.png')
      })
      expect(result.reply).toMatchObject({ file: 'attachments/note/alias.png' })
    })

    it('shows files when the vault root itself is a link', async () => {
      fs.symlinkSync(vault, `${vault}-link`)

      const result = await viewVaultFile(deps({ vaultPath: `${vault}-link` }), { id: 'shot' })

      expect(prepared[0]?.source).toEqual({
        kind: 'file',
        path: path.join(vault, 'Screens/login.png')
      })
      expect(result.reply).toMatchObject({ file: 'Screens/login.png' })
    })
  })
})
