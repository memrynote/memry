/**
 * A note cover, end to end against a real vault on disk.
 *
 * The claim under test is about bytes: the `cover` frontmatter key holds the
 * note-relative ref the attachment upload produced, the renderer resolves it to
 * a `memry-file://` URL only to paint it, and "Remove cover" takes the line back
 * out of the file. A resolved URL in the file would carry this machine's vault
 * path to every other device, so every read of the file is checked for one.
 */

import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { PNG_BYTES } from './utils/desktop-test-helpers'
import { seedNote, waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import { openNoteByHandle, waitForNoteById } from './utils/note-sync-helpers'

const COVER_FILENAME = 'cover-photo.png'

test.describe('Note cover image', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('stores a note-relative ref on disk, paints it resolved, and removes it', async ({
    page,
    testVaultPath
  }) => {
    const title = `Cover Note ${Date.now()}`
    const noteId = await seedNote(page, title, 'Cover body text')

    const seeded = await page.evaluate(
      async ({ id, fileName, bytes }) => {
        const file = new File([new Uint8Array(bytes)], fileName, { type: 'image/png' })
        const uploaded = await window.api.notes.uploadAttachment(id, file)
        if (!uploaded.success || !uploaded.path) {
          throw new Error(uploaded.error ?? 'cover attachment upload failed')
        }
        await window.api.notes.update({ id, frontmatter: { cover: uploaded.path } })
        const note = await window.api.notes.get(id)
        if (!note?.path) throw new Error('note has no path after update')
        return { coverRef: uploaded.path, notePath: note.path }
      },
      { id: noteId, fileName: COVER_FILENAME, bytes: PNG_BYTES }
    )

    const noteFile = path.join(testVaultPath, seeded.notePath)
    const withCover = fs.readFileSync(noteFile, 'utf-8')
    expect(seeded.coverRef).toContain(`attachments/${noteId}/`)
    expect(seeded.coverRef).not.toMatch(/^([a-zA-Z][a-zA-Z\d+\-.]*:|\/)/)
    expect(withCover).toContain(`cover: ${seeded.coverRef}`)
    expect(withCover).not.toContain('memry-file://')
    expect(withCover).not.toContain(testVaultPath)

    await openNoteByHandle(page, await waitForNoteById(page, noteId, title))

    const cover = page.getByTestId('note-cover')
    await expect(cover).toBeVisible()
    await expect(cover).toHaveAttribute('data-cover-kind', 'image')
    await expect(cover.locator('img')).toHaveAttribute('src', /^memry-file:\/\//)

    await cover.hover()
    await cover.getByRole('button', { name: 'Remove cover' }).click()

    await expect(cover).toBeHidden()
    await expect
      .poll(() => fs.readFileSync(noteFile, 'utf-8'), { timeout: 20_000 })
      .not.toContain('cover:')

    const withoutCover = fs.readFileSync(noteFile, 'utf-8')
    expect(withoutCover).not.toContain(seeded.coverRef)
    expect(withoutCover).not.toContain('memry-file://')
    expect(withoutCover).not.toContain(testVaultPath)
    expect(withoutCover).toContain('Cover body text')
  })

  test('picks a wash from the ghost chip and writes it as wash:<id>', async ({
    page,
    testVaultPath
  }) => {
    const title = `Wash Note ${Date.now()}`
    const noteId = await seedNote(page, title, 'Wash body text')
    await openNoteByHandle(page, await waitForNoteById(page, noteId, title))

    const notePath = await page.evaluate(async (id) => {
      const note = await window.api.notes.get(id)
      if (!note?.path) throw new Error('note has no path')
      return note.path
    }, noteId)
    const noteFile = path.join(testVaultPath, notePath)

    // The chips only take pointer events while the metadata block is hovered,
    // so the hover has to land inside that block rather than on the body.
    await page.getByTestId('note-metadata').hover()
    await page.getByTestId('ghost-add-cover').click()

    const picker = page.getByTestId('cover-picker-dialog')
    await expect(picker).toBeVisible()
    await picker.getByTestId('cover-picker-wash').first().click()
    await expect(picker).toBeHidden()

    const cover = page.getByTestId('note-cover')
    await expect(cover).toHaveAttribute('data-cover-kind', 'wash')
    // A wash is pigment, not a file: nothing may be fetched for it.
    await expect(cover.locator('img')).toHaveCount(0)

    // YAML quotes a scalar holding a colon, so the written line is
    // `cover: 'wash:sage'`. Pin the value, not one serialiser's quoting.
    await expect
      .poll(() => fs.readFileSync(noteFile, 'utf-8'), { timeout: 20_000 })
      .toMatch(/^cover: ['"]?wash:sage['"]?$/m)
    expect(fs.readFileSync(noteFile, 'utf-8')).not.toContain('memry-file://')
  })
})
