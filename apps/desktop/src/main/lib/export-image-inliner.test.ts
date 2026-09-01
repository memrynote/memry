import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('./logger', () => ({
  createLogger: () => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { toMemryFileUrl } from './paths'
import { inlineExportImages } from './export-image-inliner'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)
const PNG_BASE64 = PNG_BYTES.toString('base64')

let vaultPath: string
let outsidePath: string

beforeEach(() => {
  mocks.warn.mockClear()
  vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-export-vault-'))
  outsidePath = mkdtempSync(path.join(tmpdir(), 'memry-export-outside-'))
  mkdirSync(path.join(vaultPath, 'attachments', 'note-a'), { recursive: true })
  mkdirSync(path.join(vaultPath, 'Folder'), { recursive: true })
  writeFileSync(path.join(vaultPath, 'attachments', 'note-a', 'photo.png'), PNG_BYTES)
})

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true })
  rmSync(outsidePath, { recursive: true, force: true })
})

describe('inlineExportImages', () => {
  it('inlines a note-relative image as a data URI carrying the file bytes', async () => {
    const html = await inlineExportImages(
      '<p><img src="../attachments/note-a/photo.png" alt="pic"></p>',
      { notePath: 'Folder/Note.md', vaultPath }
    )

    expect(html).toBe(`<p><img src="data:image/png;base64,${PNG_BASE64}" alt="pic"></p>`)
  })

  it('resolves a relative ref for a note that sits at the vault root', async () => {
    const html = await inlineExportImages('<img src="attachments/note-a/photo.png">', {
      notePath: 'Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:image/png;base64,${PNG_BASE64}">`)
  })

  it('percent-decodes a relative ref before reading it off disk', async () => {
    writeFileSync(path.join(vaultPath, 'attachments', 'note-a', 'my photo.png'), PNG_BYTES)

    const html = await inlineExportImages('<img src="attachments/note-a/my%20photo.png">', {
      notePath: 'Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:image/png;base64,${PNG_BASE64}">`)
  })

  it('inlines an image that lives outside the vault', async () => {
    const outside = path.join(outsidePath, 'outside.png')
    writeFileSync(outside, PNG_BYTES)

    const html = await inlineExportImages(`<img src="${outside}">`, {
      notePath: 'Folder/Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:image/png;base64,${PNG_BASE64}">`)
  })

  it('inlines an outside-the-vault image referenced by file:// URL', async () => {
    const outside = path.join(outsidePath, 'outside.png')
    writeFileSync(outside, PNG_BYTES)

    const html = await inlineExportImages(`<img src="${pathToFileURL(outside).href}">`, {
      notePath: 'Folder/Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:image/png;base64,${PNG_BASE64}">`)
  })

  it('inlines a legacy memry-file:// ref', async () => {
    const outside = path.join(outsidePath, 'my photo.png')
    writeFileSync(outside, PNG_BYTES)

    const html = await inlineExportImages(`<img src="${toMemryFileUrl(outside)}">`, {
      notePath: 'Folder/Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:image/png;base64,${PNG_BASE64}">`)
  })

  it('leaves an unreadable path untouched and logs it', async () => {
    const source = '<img src="attachments/note-a/missing.png">'

    const html = await inlineExportImages(source, { notePath: 'Note.md', vaultPath })

    expect(html).toBe(source)
    expect(mocks.warn).toHaveBeenCalledWith(
      'Export could not inline an image, leaving the reference as written',
      expect.objectContaining({ src: 'attachments/note-a/missing.png' })
    )
  })

  it('leaves data:, http: and https: sources alone without reading disk', async () => {
    const source =
      '<img src="data:image/gif;base64,R0lGOD"><img src="https://example.com/a.png"><img src="http://example.com/b.png">'

    expect(await inlineExportImages(source, { notePath: 'Note.md', vaultPath })).toBe(source)
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('leaves a ref that climbs above the vault root untouched', async () => {
    const source = '<img src="../../escape.png">'

    expect(await inlineExportImages(source, { notePath: 'Folder/Note.md', vaultPath })).toBe(source)
  })

  it('falls back to application/octet-stream for an unknown extension', async () => {
    writeFileSync(path.join(vaultPath, 'attachments', 'note-a', 'photo.heic'), PNG_BYTES)

    const html = await inlineExportImages('<img src="attachments/note-a/photo.heic">', {
      notePath: 'Note.md',
      vaultPath
    })

    expect(html).toBe(`<img src="data:application/octet-stream;base64,${PNG_BASE64}">`)
  })

  it('rewrites every occurrence of a repeated image and keeps the original quoting', async () => {
    const html = await inlineExportImages(
      '<img src="attachments/note-a/photo.png"><img src=\'attachments/note-a/photo.png\'>',
      { notePath: 'Note.md', vaultPath }
    )

    expect(html).toBe(
      `<img src="data:image/png;base64,${PNG_BASE64}"><img src='data:image/png;base64,${PNG_BASE64}'>`
    )
  })

  it('leaves the html alone when the note path or the vault path is unknown', async () => {
    const source = '<img src="attachments/note-a/photo.png">'

    expect(await inlineExportImages(source, { notePath: undefined, vaultPath })).toBe(source)
    expect(await inlineExportImages(source, { notePath: 'Note.md', vaultPath: null })).toBe(source)
  })

  it('does not touch a src attribute that is not on an img tag', async () => {
    const source = '<script src="attachments/note-a/photo.png"></script>'

    expect(await inlineExportImages(source, { notePath: 'Note.md', vaultPath })).toBe(source)
  })
})
