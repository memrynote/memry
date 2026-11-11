// Images inside table cells (#1640), ported from Electron's `table-cell-image.e2e.ts` (Step 14k,
// #3531). A cell holds inline content only, so before the `inlineImage` node a picture in a cell
// was dropped on parse and could not be authored. This drives the loop the unit suites cannot: a
// real editor, an attachment upload through the command, and the write-back to the vault file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expectSuggestionMenuOpen, typeInEditor } from '../../harness/editor'
import {
  NOTE_EDITOR,
  createNote,
  openFromSidebar,
  vaultOpen,
  type NoteView
} from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { blockTypes, tableLines, vaultBody } from '../../harness/table'
import { test, expect } from '../../harness/test'

/** A real 1x1 PNG: the upload checks the bytes, not just the extension. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const EMPTY_SHOT = ['| Iteration | Shot |', '| --- | --- |', '| v1 |  |', ''].join('\n')
const INLINE_ROW = /\|\s*v1\s*\|\s*!\[[^\]]*]\([^)]+\)\s*\|/

const cellImage = (page: Page) => page.locator(`${NOTE_EDITOR} td img.inline-image`).first()

/** Writes `attachments/<name>` at the vault root, where `../attachments/` from `notes/` points. */
function seedAttachment(vaultPath: string, name: string): string {
  mkdirSync(join(vaultPath, 'attachments'), { recursive: true })
  writeFileSync(join(vaultPath, 'attachments', name), Buffer.from(PNG_BASE64, 'base64'))
  return `../attachments/${name}`
}

/** A note in `notes/`, as Electron seeds the file, opened in the editor with its table there. */
async function openCellNote(page: Page, title: string, body: string): Promise<NoteView> {
  await vaultOpen(page)
  const note = await createNote(page, { title, content: body, folder: 'notes' })
  await openFromSidebar(page, note)
  await expect(page.locator(`${NOTE_EDITOR} table`).first()).toBeVisible({ timeout: 15_000 })
  return note
}

/**
 * Clicks the cell until the editor's selection is inside it: the paste handler reads
 * ProseMirror's selection, which takes the click from a later `selectionchange`.
 */
async function placeCaretInCell(cell: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await cell.click()
        return cell.evaluate((element: HTMLElement) => {
          const view = (
            window as unknown as {
              __memryActiveEditor?: {
                prosemirrorView?: {
                  state: { selection: { from: number } }
                  domAtPos(pos: number): { node: Node }
                }
              }
            }
          ).__memryActiveEditor?.prosemirrorView
          return view ? element.contains(view.domAtPos(view.state.selection.from).node) : false
        })
      },
      { timeout: 10_000 }
    )
    .toBe(true)
}

/** A paste event built in the page and dispatched at the editor, which the app's listener reads. */
const dispatchPaste = (page: Page, payload: { base64?: string; name?: string; html?: string }) =>
  page.evaluate(({ base64, name, html }: { base64?: string; name?: string; html?: string }) => {
    const data = new DataTransfer()
    if (base64 && name) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      data.items.add(new File([bytes], name, { type: 'image/png' }))
    }
    if (html) data.setData('text/html', html)
    document
      .querySelector('[aria-label="Rich text editor"] [contenteditable="true"]')
      ?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
  }, payload)

test('an image written into a cell on disk opens as an image and is not rewritten', async ({
  page,
  testVaultPath
}) => {
  const ref = seedAttachment(testVaultPath, 'progress.png')
  const body = ['| Iteration | Shot |', '| --- | --- |', `| v1 | ![progress.png](${ref}) |`, '']
  const note = await openCellNote(page, `Cell Image ${Date.now()}`, body.join('\n'))

  await expect(cellImage(page)).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => (await cellImage(page).getAttribute('src')) ?? '', { timeout: 15_000 })
    .toContain('progress.png')

  // An edit elsewhere, undone, makes the editor serialize again; the relative ref stays on disk.
  await page.locator(NOTE_EDITOR).getByText('Iteration', { exact: true }).click()
  await typeInEditor(page, 'x')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(2500)
  const saved = vaultBody(testVaultPath, note.path)
  expect(saved).toContain(`![progress.png](${ref})`)
  expect(saved).not.toContain('memry-file://')
  expect(saved).not.toMatch(/!\[progress\.png]\(\/.*\)/)
  expect(saved).toMatch(/\|\s*v1\s*\|\s*!\[progress\.png]\(\.\.\/attachments\/progress\.png\)\s*\|/)
  expect(tableLines(saved)).toHaveLength(3)
})

test('choosing Image from the slash menu puts the picture in the cell', async ({
  page,
  testVaultPath
}) => {
  // Before the fix `/image` in a cell put an image block after the table and left the cell empty.
  const note = await openCellNote(page, `Cell Slash ${Date.now()}`, EMPTY_SHOT)

  // The picker is a hidden file input the hook clicks. The click is held here instead of opening
  // the native panel, and the file goes to the input as the panel would hand it over.
  await page.evaluate(() => {
    const original = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type !== 'file') return original.call(this)
      ;(window as unknown as { __memryE2EPicker?: HTMLInputElement }).__memryE2EPicker = this
    }
  })

  await placeCaretInCell(page.locator(`${NOTE_EDITOR} tbody td`).nth(1))
  await typeInEditor(page, '/image')
  await expectSuggestionMenuOpen(page, 'Image')
  await page.keyboard.press('Enter')

  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { __memryE2EPicker?: HTMLInputElement }).__memryE2EPicker)
      )
    )
    .toBe(true)
  await page.evaluate((base64: string) => {
    const input = (window as unknown as { __memryE2EPicker: HTMLInputElement }).__memryE2EPicker
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'picked.png', { type: 'image/png' }))
    input.files = data.files
    input.dispatchEvent(new Event('change'))
  }, PNG_BASE64)

  await expect(cellImage(page)).toBeVisible({ timeout: 20_000 })
  expect(await blockTypes(page)).not.toContain('image')
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(INLINE_ROW)
})

test('dragging the grip resizes the picture and the width reaches the file', async ({
  page,
  testVaultPath
}) => {
  // A cell image without a size is capped at eight lines, which makes a per-image width matter.
  const ref = seedAttachment(testVaultPath, 'wide.png')
  const body = ['| Iteration | Shot |', '| --- | --- |', `| v1 | ![wide.png](${ref}) |`, '']
  const note = await openCellNote(page, `Cell Resize ${Date.now()}`, body.join('\n'))
  const image = cellImage(page)
  await expect(image).toBeVisible({ timeout: 15_000 })

  // The grip follows pointer events. The driver's pointer actions reach WKWebView as mouse events,
  // with a pointerdown and pointerup added in the page but no pointermove, so the 120 px drag is
  // dispatched on the grip as the pointer events a hand makes.
  const wrap = page.locator(`${NOTE_EDITOR} td .inline-image-wrap`).first()
  await wrap.hover()
  await wrap.locator('.inline-image-grip').evaluate((grip: HTMLElement) => {
    const box = grip.getBoundingClientRect()
    const y = box.y + box.height / 2
    const at = (type: string, x: number) =>
      grip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y
        })
      )
    const x = box.x + box.width / 2
    at('pointerdown', x)
    for (let step = 1; step <= 8; step++) at('pointermove', x + 15 * step)
    at('pointerup', x + 120)
  })

  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(100)
  // Obsidian's `|<width>` suffix, escaped: a bare `|` is the cell delimiter and would split the row.
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(/!\[wide\.png\\\|\d+]\(\.\.\/attachments\/wide\.png\)/)
  expect(tableLines(vaultBody(testVaultPath, note.path))).toHaveLength(3)
})

test('pasting an image with the caret in a cell writes it into that cell', async ({
  page,
  testVaultPath
}) => {
  const note = await openCellNote(page, `Cell Paste ${Date.now()}`, EMPTY_SHOT)
  await placeCaretInCell(page.locator(`${NOTE_EDITOR} tbody td`).nth(1))
  await dispatchPaste(page, { base64: PNG_BASE64, name: 'pasted.png' })

  // In the cell, not a block pushed out of the table as BlockNote's own paste handler does.
  await expect(cellImage(page)).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(INLINE_ROW)
  const saved = vaultBody(testVaultPath, note.path)
  expect(tableLines(saved)).toHaveLength(3)
  expect(saved).not.toContain('memry-file://')
})

test('pasting an image that arrives as HTML with no file writes it into the cell', async ({
  page,
  testVaultPath
}) => {
  // Copying a picture in Memry, a browser, Docs, Notion or Slack puts only `text/html` on the
  // clipboard; the cell stayed empty with no error.
  const note = await openCellNote(page, `Cell Html Paste ${Date.now()}`, EMPTY_SHOT)
  await placeCaretInCell(page.locator(`${NOTE_EDITOR} tbody td`).nth(1))
  await dispatchPaste(page, {
    html: `<img src="data:image/png;base64,${PNG_BASE64}" alt="grabbed">`
  })

  await expect(cellImage(page)).toBeVisible({ timeout: 20_000 })
  expect(await blockTypes(page)).not.toContain('image')
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(INLINE_ROW)
  const saved = vaultBody(testVaultPath, note.path)
  expect(tableLines(saved)).toHaveLength(3)
  // Saved as an attachment, not inlined: a screenshot's base64 would be megabytes of the note.
  expect(saved).not.toContain('data:image/png;base64')
  expect(saved).not.toContain('memry-file://')
})
