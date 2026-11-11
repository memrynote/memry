// The in-app side of Electron's `note-export-images.e2e.ts` (#1935), ported in #3531 14f-3d: a
// note whose markdown embeds an uploaded image shows that image, decoded at its own size, both
// for a small image and for one far past the URL length ceiling a `data:` URL hits. Export to
// HTML and PDF, the rest of the Electron spec, is Step 34 (#3551).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

import { uploadAttachment } from '../../harness/attachments'
import { NOTE_EDITOR, createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** A `size`x`size` RGB PNG; `level` 0 stores the pixels uncompressed, for a large file. */
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
    crc.writeUInt32BE(crc32(body))
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
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Creates and opens a note in `notes/` whose initial markdown embeds `ref`. */
async function openNoteWithImage(page: Page, title: string, ref: string): Promise<void> {
  const note = await createNote(page, { title, content: `![pic](${ref})`, folder: 'notes' })
  await openFromSidebar(page, note)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 20_000 })
}

/** A host note in `notes/`, so its attachments' refs resolve from a note beside it. */
const createHost = (page: Page, title: string) =>
  createNote(page, { title: `${title} host`, content: 'host', folder: 'notes' })

/** The width the editor's image decoded to; 0 while it is loading or broken. */
const shownWidth = (page: Page): Promise<number> =>
  page.evaluate((selector: string) => {
    const image = document.querySelector<HTMLImageElement>(`${selector} img`)
    return image?.complete ? image.naturalWidth : 0
  }, NOTE_EDITOR)

test('a note shows the image its markdown embeds', async ({ page }) => {
  await vaultOpen(page)
  const title = `Export html images ${stamp()}`
  const host = await createHost(page, title)
  const saved = await uploadAttachment(page, host.id, 'export-pic.png', makePng(613, 9))
  expect(saved.path).toContain('attachments/')
  await openNoteWithImage(page, title, saved.path)
  await expect.poll(() => shownWidth(page), { timeout: 20_000 }).toBe(613)
})

test('a note shows an embedded image far larger than the URL length ceiling', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const png = makePng(900, 0)
  expect(png.byteLength).toBeGreaterThan(2 * 1024 * 1024)
  const title = `Export big pdf images ${stamp()}`
  const host = await createHost(page, title)
  // Written where an upload stores it: the driver refuses a request body this large.
  const folder = join(testVaultPath, 'attachments', host.id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'a1b2c3-export-pic.png'), png)
  await openNoteWithImage(page, title, `../attachments/${host.id}/a1b2c3-export-pic.png`)
  await expect.poll(() => shownWidth(page), { timeout: 30_000 }).toBe(900)
})
