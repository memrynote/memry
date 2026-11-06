// A note cover against a real vault on disk, ported from Electron's `note-cover-image.e2e.ts`
// (Step 13q-4, #3530).
//
// The claim is about bytes: the `cover` frontmatter key holds a note-relative ref, the renderer
// resolves it to a `memry-file:` URL only to paint it, and "Remove cover" takes the line back out
// of the file. A resolved URL in the file would carry this machine's vault path to every other
// device, so every read of the file is checked for one.
//
// The upload case picks a file in the cover picker, which stores it through
// `notes_upload_attachment` (#3531 14f-1); the other cases write the attachment and the `cover:`
// line to disk, as a sync or another app leaves them. Removing a cover writes the frontmatter
// through `notes.update({ frontmatter })` (13q-2). The cover picker opens from the header's
// details menu, which the harness opens from the keyboard (`openDetailsMenu`, #3986).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { openDetailsMenu, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const COVER_FILENAME = 'cover-photo.png'
// A 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
// The canonical form, or the one WebView2 serves a custom scheme from (`toWebviewUrl`).
const PAINTED_URL = /^(memry-file:\/\/local\/|https:\/\/memry-file\.localhost\/local\/)/

interface NoteView {
  id: string
  path: string
  title: string
  frontmatter: Record<string, unknown>
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
  await vaultOpen(page)
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

  // An app write to the frontmatter rewrites the block the cover line is in; the ref keeps its
  // bytes, and no painted URL or vault path reaches the file.
  await invoke(page, 'properties_merge', { entityId: note.id, values: { Probe: 'x' } })
  await expect.poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 }).toContain('Probe:')
  const onDisk = readFileSync(noteFile, 'utf8')
  expect(onDisk.split(/\r?\n/)).toContain(`cover: ${coverRef}`)
  expect(onDisk).not.toContain('memry-file:')
  expect(onDisk).not.toContain(testVaultPath)
})

test('an uploaded cover is stored as a note-relative attachment ref', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Upload Cover Note ${Date.now()}`, content: 'Upload body text' }
  })
  await openFromSidebar(page, note)
  const noteFile = join(testVaultPath, note.path)

  await openDetailsMenu(page)
  await page.getByTestId('ghost-add-cover').click()
  const picker = page.getByTestId('cover-picker-dialog')
  await expect(picker).toBeVisible()
  // The file a user picks in the system dialog the upload tile opens.
  await page.getByTestId('cover-picker-file-input').evaluate(
    (input: HTMLInputElement, { name, base64 }: { name: string; base64: string }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const files = new DataTransfer()
      files.items.add(new File([bytes], name, { type: 'image/png' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { name: COVER_FILENAME, base64: PNG_BYTES.toString('base64') }
  )
  await expect(picker).toBeHidden()
  await expect(page.getByTestId('note-cover')).toHaveAttribute('data-cover-kind', 'image')

  await expect.poll(() => readFileSync(noteFile, 'utf8'), { timeout: 20_000 }).toMatch(/^cover: /m)
  const coverRef = (readFileSync(noteFile, 'utf8').match(/^cover: (.*?)\r?$/m) ?? [])[1] ?? ''
  expect(coverRef).toContain(`attachments/${note.id}/`)
  // Neither a URL nor an absolute path.
  expect(coverRef).not.toMatch(/^([a-zA-Z][a-zA-Z\d+\-.]*:|\/)/)
  expect(readFileSync(noteFile, 'utf8')).not.toContain(testVaultPath)
  // The ref names the picked file's bytes, relative to the note.
  expect(readFileSync(join(dirname(noteFile), coverRef))).toEqual(PNG_BYTES)
})

test('Remove cover takes the cover line out of the file', async ({ page, testVaultPath }) => {
  await vaultOpen(page)
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

test('picks a wash from the ghost chip and writes it as wash:<id>', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Wash Note ${Date.now()}`, content: 'Wash body text' }
  })
  await openFromSidebar(page, note)
  const noteFile = join(testVaultPath, note.path)

  await openDetailsMenu(page)
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
