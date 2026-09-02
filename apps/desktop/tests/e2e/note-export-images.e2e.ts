/**
 * Note export image embedding E2E (issue #1935)
 *
 * A note that embeds an attachment must keep that image in both export
 * formats. PDF export loads the rendered HTML through a `data:` URL, which has
 * no base URL, so a relative `<img src="attachments/…">` used to arrive at
 * `printToPDF` broken. HTML export only looked right while the file sat next to
 * the attachments folder.
 *
 * Export is driven through `window.api.notes.export*` with an explicit
 * `outputPath`. That is the same handler the note menu invokes; the menu path
 * itself opens a native save dialog, which Playwright cannot answer.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

/**
 * A `size`x`size` RGB PNG. `level` 0 stores the pixels uncompressed, which is
 * how the large case reaches the megabytes needed to clear Chromium's URL
 * length ceiling, the ceiling a phone photograph clears on its own.
 */
function makePng(size: number, level: number): Buffer {
  const stride = size * 3 + 1
  const raw = Buffer.alloc(size * stride)
  for (let i = 0; i < raw.length; i++) raw[i] = i % 251
  for (let y = 0; y < size; y++) raw[y * stride] = 0

  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The image the exported note embeds, wide enough to tell from a broken-image icon. */
const IMAGE_WIDTH = 613
const PNG_BYTES = makePng(IMAGE_WIDTH, 9)
const PNG_BASE64 = PNG_BYTES.toString('base64')

/**
 * The widest image object in a PDF. Chromium always writes some image, so the
 * presence of one proves nothing. A broken reference leaves only the tiny
 * broken-image icon, while a resolved one embeds the note's own bitmap.
 */
function widestEmbeddedImage(pdf: Buffer): number {
  const widths = [...pdf.toString('latin1').matchAll(/\/Width\s+(\d+)/g)].map((m) => Number(m[1]))
  return widths.length > 0 ? Math.max(...widths) : 0
}

interface SeededNote {
  noteId: string
  /** The note-relative ref the markdown carries, e.g. `../attachments/<id>/x.png`. */
  ref: string
}

/**
 * A note whose body embeds a real uploaded attachment.
 *
 * The attachment is uploaded against a host note created first, then the
 * exported note is created WITH the markdown embed as its initial content,
 * because a post-create update loses to the CRDT body.
 */
async function seedNoteWithImage(
  page: Page,
  title: string,
  png: Buffer = PNG_BYTES
): Promise<SeededNote> {
  return page.evaluate(
    async ({ t, base64 }) => {
      const api = window.api

      const host = await api.notes.create({ title: `${t} host`, content: 'attachment host' })
      if (!host.success || !host.note) throw new Error(host.error ?? 'host note create failed')

      // base64 rather than a number array, so a multi-megabyte image serialises
      // into the page in a fraction of the time.
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const file = new File([bytes], 'export-pic.png', { type: 'image/png' })
      const uploaded = await api.notes.uploadAttachment(host.note.id, file)
      if (!uploaded.success || !uploaded.path) {
        throw new Error(uploaded.error ?? 'attachment upload failed')
      }

      const note = await api.notes.create({ title: t, content: `![pic](${uploaded.path})` })
      if (!note.success || !note.note) throw new Error(note.error ?? 'note create failed')

      return { noteId: note.note.id, ref: uploaded.path }
    },
    { t: title, base64: png.toString('base64') }
  )
}

test.describe('Note export keeps embedded images', () => {
  let exportDir: string
  let movedDir: string

  test.beforeEach(async ({ page }) => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-export-'))
    movedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-export-moved-'))
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test.afterEach(() => {
    fs.rmSync(exportDir, { recursive: true, force: true })
    fs.rmSync(movedDir, { recursive: true, force: true })
  })

  test('exported HTML carries the image after the file is moved', async ({ page }) => {
    const seeded = await seedNoteWithImage(page, 'Export html images')
    expect(seeded.ref).toContain('attachments/')

    const outputPath = path.join(exportDir, 'note.html')
    const result = await page.evaluate(
      async ({ noteId, out }) =>
        window.api.notes.exportHtml({ noteId, includeMetadata: false, outputPath: out }),
      { noteId: seeded.noteId, out: outputPath }
    )
    expect(result.success, result.error ?? 'export failed').toBe(true)

    const movedPath = path.join(movedDir, 'note.html')
    fs.renameSync(outputPath, movedPath)
    const html = fs.readFileSync(movedPath, 'utf-8')

    const src = /<img[^>]*\ssrc="([^"]*)"/.exec(html)?.[1]
    expect(src, 'exported html has no <img>').toBeTruthy()
    expect(src).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(html).not.toContain('attachments/')
  })

  test('exported PDF embeds the image rather than a broken reference', async ({ page }) => {
    const seeded = await seedNoteWithImage(page, 'Export pdf images')

    const outputPath = path.join(exportDir, 'note.pdf')
    const result = await page.evaluate(
      async ({ noteId, out }) =>
        window.api.notes.exportPdf({
          noteId,
          includeMetadata: false,
          pageSize: 'A4',
          outputPath: out
        }),
      { noteId: seeded.noteId, out: outputPath }
    )
    expect(result.success, result.error ?? 'export failed').toBe(true)

    const pdf = fs.readFileSync(outputPath)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('/Image')
    const widest = widestEmbeddedImage(pdf)
    expect(widest, `widest embedded image was ${widest}px`).toBeGreaterThan(64)
  })

  test('exported PDF embeds an image far larger than the URL length ceiling', async ({ page }) => {
    const png = makePng(900, 0)
    expect(png.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    const seeded = await seedNoteWithImage(page, 'Export big pdf images', png)

    const outputPath = path.join(exportDir, 'big.pdf')
    const result = await page.evaluate(
      async ({ noteId, out }) =>
        window.api.notes.exportPdf({
          noteId,
          includeMetadata: false,
          pageSize: 'A4',
          outputPath: out
        }),
      { noteId: seeded.noteId, out: outputPath }
    )
    expect(result.success, result.error ?? 'export failed').toBe(true)

    const pdf = fs.readFileSync(outputPath)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const widest = widestEmbeddedImage(pdf)
    expect(widest, `widest embedded image was ${widest}px`).toBeGreaterThan(64)
  })
})
