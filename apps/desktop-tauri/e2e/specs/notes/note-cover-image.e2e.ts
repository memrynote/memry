// A note cover against a real vault on disk, ported from Electron's `note-cover-image.e2e.ts`
// (Step 13q-4, #3530).
//
// The claim is about bytes: the `cover` frontmatter key holds a note-relative ref, the renderer
// resolves it to a `memry-file:` URL only to paint it, and "Remove cover" takes the line back out
// of the file. A resolved URL in the file would carry this machine's vault path to every other
// device, so every read of the file is checked for one.
//
// Electron seeds the cover through `notes.uploadAttachment`, whose attachment writer is Step 14's
// (#3531); here the attachment and the `cover:` line are written to disk, as a sync or another
// app leaves them. Removing a cover and picking a wash write the frontmatter through
// `notes.update({ frontmatter })`, which slice 13q-2 ports; those cases are pending until then.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const COVER_FILENAME = 'cover-photo.png'
// A 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const NOTE_TITLE = 'textarea[aria-label="Note title"]'
// The canonical form, or the one WebView2 serves a custom scheme from (`toWebviewUrl`).
const PAINTED_URL = /^(memry-file:\/\/local\/|https:\/\/memry-file\.localhost\/local\/)/

interface NoteView {
  id: string
  path: string
  title: string
  frontmatter: Record<string, unknown>
}

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** Opens a vault-root note from the Collections tree, as a user does. */
async function openFromSidebar(page: Page, note: NoteView): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await page.locator(`[data-tree-node-id="${note.id}"]`).click()
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
}

/** Adds `key: value` to the file's frontmatter block, making one when it has none. */
function addFrontmatterLine(file: string, line: string): void {
  const text = readFileSync(file, 'utf8')
  const next = text.startsWith('---\n')
    ? `---\n${line}\n${text.slice(4)}`
    : `---\n${line}\n---\n${text}`
  writeFileSync(file, next)
}

/** A note whose file names a cover image stored beside it, as the attachment upload leaves it. */
async function noteWithImageCover(
  page: Page,
  testVaultPath: string
): Promise<{ note: NoteView; coverRef: string; noteFile: string }> {
  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Cover Note ${Date.now()}`, content: 'Cover body text' }
  })
  const coverRef = `attachments/${note.id}/${COVER_FILENAME}`
  mkdirSync(join(testVaultPath, 'attachments', note.id), { recursive: true })
  writeFileSync(join(testVaultPath, coverRef), PNG_BYTES)
  const noteFile = join(testVaultPath, note.path)
  addFrontmatterLine(noteFile, `cover: ${coverRef}`)
  await expect
    .poll(
      async () => (await invoke<NoteView>(page, 'notes_get', { id: note.id })).frontmatter.cover
    )
    .toBe(coverRef)
  return { note, coverRef, noteFile }
}

test('a cover ref in the file paints resolved, and the file keeps the ref', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const { note, coverRef, noteFile } = await noteWithImageCover(page, testVaultPath)
  await openFromSidebar(page, note)

  const cover = page.getByTestId('note-cover')
  await expect(cover).toBeVisible()
  await expect(cover).toHaveAttribute('data-cover-kind', 'image')
  const image = cover.locator('img')
  await expect(image).toHaveAttribute('src', PAINTED_URL)
  // The scheme handler served the bytes: the browser decoded an image.
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(1)

  const onDisk = readFileSync(noteFile, 'utf8')
  expect(onDisk).toContain(`cover: ${coverRef}`)
  expect(onDisk).not.toContain('memry-file:')
  expect(onDisk).not.toContain(testVaultPath)
})

// Pending: "Remove cover" writes through `notes.update({ frontmatter })` (slice 13q-2, #3530).
test.skip('Remove cover takes the cover line out of the file', async ({ page, testVaultPath }) => {
  await ready(page)
  const { note, coverRef, noteFile } = await noteWithImageCover(page, testVaultPath)
  await openFromSidebar(page, note)

  const cover = page.getByTestId('note-cover')
  await expect(cover).toBeVisible()
  await cover.hover()
  await cover.getByRole('button', { name: 'Remove cover' }).click()

  await expect(cover).toBeHidden()
  await expect
    .poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 })
    .not.toContain('cover:')
  const withoutCover = readFileSync(noteFile, 'utf8')
  expect(withoutCover).not.toContain(coverRef)
  expect(withoutCover).not.toContain('memry-file:')
  expect(withoutCover).not.toContain(testVaultPath)
  expect(withoutCover).toContain('Cover body text')
})

// Pending: a picked wash writes through `notes.update({ frontmatter })` (slice 13q-2, #3530).
test.skip('picks a wash from the ghost chip and writes it as wash:<id>', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Wash Note ${Date.now()}`, content: 'Wash body text' }
  })
  await openFromSidebar(page, note)
  const noteFile = join(testVaultPath, note.path)

  // The details menu takes pointer events only while the metadata block is hovered.
  await page.getByTestId('note-metadata').hover()
  await page.getByTestId('ghost-add-details').click()
  await page.getByTestId('ghost-add-cover').click()
  const picker = page.getByTestId('cover-picker-dialog')
  await expect(picker).toBeVisible()
  await picker.getByTestId('cover-picker-wash').first().click()
  await expect(picker).toBeHidden()

  const cover = page.getByTestId('note-cover')
  await expect(cover).toHaveAttribute('data-cover-kind', 'wash')
  // A wash is pigment, not a file: nothing is fetched for it.
  await expect(cover.locator('img')).toHaveCount(0)

  // YAML quotes a scalar holding a colon; pin the value, not one serialiser's quoting.
  await expect
    .poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 })
    .toMatch(/^cover: ['"]?wash:sage['"]?$/m)
  expect(readFileSync(noteFile, 'utf8')).not.toContain('memry-file:')
})
