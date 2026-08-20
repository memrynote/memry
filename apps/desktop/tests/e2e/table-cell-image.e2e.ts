// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Images in table cells (#1640), against the real editor and the real vault.
 *
 * A BlockNote table cell holds inline content only, so before the `inlineImage`
 * node an `<img>` in a cell matched no node at all: the note came back from disk
 * with an empty cell, and the next write-back wrote the emptiness to the file.
 * Unit tests can prove the spec's shape; only this can prove the whole loop —
 * disk → editor → disk — with the resolver, the debounce and the write-back all
 * in play.
 *
 * The second half is the other half of the feature: a user pasting a screenshot
 * into a cell. That path is a ProseMirror plugin scoped to cells, because
 * BlockNote's own file paste always builds a BLOCK.
 *
 * What both assert about the bytes matters as much as the image being there:
 * the vault file must keep the note-relative ref. The editor resolves it to an
 * absolute `memry-file://` URL to display it, and that URL carries THIS
 * machine's vault path — writing it back would sync one machine's filesystem
 * layout to every other device.
 */

import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { SELECTORS } from './utils/electron-helpers'
import { getNoteHandleByTitle, openNoteByTitle } from './utils/note-sync-helpers'
import { PNG_BYTES, ready, uniqueLabel } from './utils/desktop-test-helpers'

const IMAGE_NAME = 'shot.png'

/** A table whose second column is an image, plus a paragraph to type into. */
const BODY = [
  '| Iteration | Shot |',
  '| --- | --- |',
  `| v1 | ![v1](${IMAGE_NAME}) |`,
  '',
  'Notes:'
].join('\n')

function seedNoteWithImage(vaultPath: string, title: string): string {
  const notesDir = path.join(vaultPath, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, IMAGE_NAME), Buffer.from(PNG_BYTES))
  const absPath = path.join(notesDir, `${title}.md`)
  fs.writeFileSync(absPath, BODY, 'utf8')
  return absPath
}

/** Drop the YAML frontmatter block; every save bumps its `modified:` stamp. */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/)
  return match ? markdown.slice(match[0].length) : markdown
}

function readFile(absPath: string): string {
  try {
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return ''
  }
}

/** Read the note file once it contains `marker` (waits out the write-back debounce). */
async function readWhenContains(absPath: string, marker: string): Promise<string> {
  await expect.poll(() => readFile(absPath), { timeout: 30_000 }).toContain(marker)
  return readFile(absPath)
}

async function openEditor(page: Page, title: string) {
  await openNoteByTitle(page, title)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  return editor
}

/**
 * Paste a PNG into whatever the editor's selection currently is.
 *
 * Dispatched on the editor's own contenteditable, which is where ProseMirror
 * binds its `paste` handler — the plugin under test reads the files off the
 * event exactly as it would from a real ⌘V.
 */
async function pasteImage(page: Page, fileName: string): Promise<void> {
  await page.evaluate(
    ({ selector, bytes, name }) => {
      const dom = document.querySelector(selector) as HTMLElement | null
      if (!dom) throw new Error('editor not found')
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      // Chromium's `ClipboardEvent` constructor ignores a `clipboardData` in the
      // init dict, so the transfer is attached to the instance instead.
      Object.defineProperty(event, 'clipboardData', { value: transfer })
      dom.dispatchEvent(event)
    },
    { selector: SELECTORS.noteEditor, bytes: PNG_BYTES, name: fileName }
  )
}

test.describe('Images in table cells', () => {
  test('a cell image opens, renders, and is written back as the ref it came from', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    // #given a vault note whose table already holds an image, as another editor
    // (or another device) wrote it
    const title = uniqueLabel('Cell Image')
    const absPath = seedNoteWithImage(testVaultPath, title)
    await getNoteHandleByTitle(page, title)

    // #when the note is opened in the real editor
    const editor = await openEditor(page, title)

    // #then the image is inside the table, not dropped and not moved out of it
    const cellImage = editor.locator('table img.inline-image').first()
    await expect(cellImage).toBeVisible({ timeout: 15_000 })
    // …and it is actually loadable: the note-relative ref has been resolved to a
    // URL the renderer can fetch
    await expect
      .poll(async () => await cellImage.getAttribute('src'), { timeout: 15_000 })
      .toMatch(/^memry-file:\/\//)

    // #when the note is edited, so write-back runs over the whole document
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' touched')

    // #then the file still carries the image, in the form it was written with
    const markdown = stripFrontmatter(await readWhenContains(absPath, 'touched'))
    expect(markdown).toContain(`![v1](${IMAGE_NAME})`)
    // …and never this machine's vault path, which is what the editor resolved
    // the ref to in order to show it
    expect(markdown).not.toContain('memry-file://')
    expect(markdown).not.toContain(testVaultPath)
    // …and the table is still a table
    expect(markdown).toMatch(/\|\s*v1\s*\|/)
  })

  test('pasting an image into a cell inserts it inline and reaches the vault file', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    // #given the same note, opened, with the caret placed in a table cell
    const title = uniqueLabel('Cell Paste')
    const absPath = seedNoteWithImage(testVaultPath, title)
    await getNoteHandleByTitle(page, title)
    const editor = await openEditor(page, title)
    await expect(editor.locator('table').first()).toBeVisible({ timeout: 15_000 })

    const firstCell = editor.locator('table td, table th').filter({ hasText: 'v1' }).first()
    await firstCell.click()

    // #when a screenshot is pasted into it
    await pasteImage(page, 'pasted.png')

    // #then it lands in that cell as an inline image — BlockNote's own paste
    // would have built a block, which a cell cannot hold
    await expect(firstCell.locator('img.inline-image')).toHaveCount(1, { timeout: 20_000 })
    // …and nowhere else: BlockNote's own file paste was landing an image BLOCK
    // below the table, which is the behaviour this plugin has to get in front of
    await expect(editor.locator('img.inline-image')).toHaveCount(2)
    await expect(editor.locator('[data-content-type="image"]')).toHaveCount(0)

    // #and the upload is stored as a note-relative attachment ref, so the note
    // still reads correctly on another device
    const markdown = stripFrontmatter(await readWhenContains(absPath, 'pasted'))
    expect(markdown).toMatch(/\|[^|\n]*!\[pasted\]\([^)\n]*pasted[^)\n]*\.png\)[^|\n]*\|/)
    expect(markdown).not.toContain('memry-file://')
    expect(markdown).not.toContain(testVaultPath)
  })
})
