// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Images inside table cells — the real app (#1640).
 *
 * A `tableCell` holds inline content only, so before the `inlineImage` node
 * existed a picture in a cell was impossible in both directions: `![a](x.png)`
 * on disk was silently dropped on parse, and nothing in the editor could author
 * one. The unit suites cover each half (`inline-image.test.ts`,
 * `blocknote-converter.test.ts`, `use-table-cell-image.test.ts`); none of them
 * can run the loop the user actually walks — a real editor, a real attachment
 * upload through IPC, and the debounced write-back landing real bytes on disk.
 *
 * That loop is what this file drives, and the vault file is what it reads.
 */

import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import type { FileChooser, Page } from '@playwright/test'
import { waitForAppReady, waitForVaultReady, SELECTORS } from './utils/electron-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'

/** A real 1×1 PNG — the upload path checks the bytes, not just the extension. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/** Drop the YAML frontmatter block; every save bumps its `modified:` stamp. */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/)
  return match ? markdown.slice(match[0].length) : markdown
}

async function openInEditor(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** Force a re-serialize/re-save without changing content. */
async function retriggerSave(page: Page): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('x')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(2500)
}

/**
 * A real `paste` carrying an image file, dispatched at the caret.
 *
 * Playwright cannot put a file on the OS clipboard, and the gesture under test
 * is precisely "an image arrives on the paste event while the caret is in a
 * cell" — so the event is built in the page with a real `File` and dispatched
 * from the editor, where the app's own capture-phase listener picks it up.
 */
async function pasteImageAtCaret(page: Page, base64: string, name: string): Promise<void> {
  await page.evaluate(
    ({ base64, name }) => {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const file = new File([bytes], name, { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      const target = document.querySelector(
        '[aria-label="Rich text editor"] [contenteditable="true"]'
      )
      target?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
    },
    { base64, name }
  )
}

/**
 * A paste carrying HTML and NO file — which is what every gesture except a
 * screenshot or a Finder copy actually delivers. BlockNote's own copy handler
 * clears the clipboard's files and writes `text/html`; so does every browser,
 * Google Docs, Notion and Slack. Those used to reach BlockNote, which read
 * `text/html` (its accepted-MIME order puts "Files" last), built an image BLOCK,
 * and watched ProseMirror drop it because a cell holds inline content only.
 */
async function pasteHtmlAtCaret(page: Page, html: string): Promise<void> {
  await page.evaluate((html) => {
    const data = new DataTransfer()
    data.setData('text/html', html)
    const target = document.querySelector(
      '[aria-label="Rich text editor"] [contenteditable="true"]'
    )
    target?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  }, html)
}

test.describe('Table cell images', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('an image written into a cell on disk opens as an image and is not rewritten', async ({
    page,
    testVaultPath
  }) => {
    // #given a vault someone wrote by hand (or in Obsidian): a table whose cell
    // holds a note-relative image. This is the exact file that used to come back
    // with an empty cell.
    const title = `Cell Image ${Date.now()}`
    const ref = '../attachments/progress.png'
    fs.mkdirSync(path.join(testVaultPath, 'attachments'), { recursive: true })
    fs.writeFileSync(
      path.join(testVaultPath, 'attachments', 'progress.png'),
      Buffer.from(PNG_BASE64, 'base64')
    )
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Iteration | Shot |', '| --- | --- |', `| v1 | ![progress.png](${ref}) |`, ''].join('\n')
    )

    // #when the note is opened in the real editor
    await openInEditor(page, title)

    // #then the picture is in the cell, and its src has been resolved to
    // something the renderer can actually load
    const cellImage = page.locator(`${SELECTORS.noteEditor} td img.inline-image`).first()
    await expect(cellImage).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => (await cellImage.getAttribute('src')) ?? '', { timeout: 15_000 })
      .toContain('progress.png')

    // #and the file is not rewritten: the relative ref is what stays on disk, so
    // the note still resolves on the next device
    await retriggerSave(page)
    const body = stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
    expect(body).toContain(`![progress.png](${ref})`)
    expect(body).not.toContain('memry-file://')
    expect(body).not.toMatch(/!\[progress\.png]\(\/.*\)/)
    // The cell is still a cell — a claimed `<td>` would have eaten the table.
    // (remark re-pads column widths on every save, so the row is matched loosely)
    expect(body).toMatch(
      /\|\s*v1\s*\|\s*!\[progress\.png]\(\.\.\/attachments\/progress\.png\)\s*\|/
    )
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
  })

  test('choosing Image from the slash menu puts the picture in the cell', async ({
    page,
    testVaultPath
  }) => {
    // #given the gesture people actually reach for. Before this, `/image` in a
    // cell inserted an image BLOCK *after the whole table* and moved the caret
    // out of the cell with it — the cell stayed empty and there was no way to
    // get a picture into it at all.
    const title = `Cell Slash ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Iteration | Shot |', '| --- | --- |', '| v1 |  |', ''].join('\n')
    )
    await openInEditor(page, title)

    // Registered up front, not next to the keypress: turning on Playwright's
    // file-chooser interception is a CDP round-trip, and `waitForEvent` issued
    // one line before the click loses the race and never sees the chooser.
    const chooserPromise = new Promise<FileChooser>((resolve) => page.once('filechooser', resolve))

    // #when the caret is in the second cell and Image is chosen from the menu
    const cell = page.locator(`${SELECTORS.noteEditor} tbody td`).nth(1)
    await cell.click()
    await page.keyboard.type('/image')
    await expect(page.getByText('Image', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Enter')

    const chooser = await chooserPromise
    await chooser.setFiles({
      name: 'picked.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64')
    })

    // #then the picture is IN the cell…
    const cellImage = page.locator(`${SELECTORS.noteEditor} td img.inline-image`).first()
    await expect(cellImage).toBeVisible({ timeout: 20_000 })

    // …and no image block was added beside the table, which is the old bug
    const blockTypes = await page.evaluate(() =>
      (window as any).__memryEditor.document.map((block: any) => block.type as string)
    )
    expect(blockTypes).not.toContain('image')

    // #and the row on disk carries it as inline markdown
    await expect
      .poll(
        () => {
          try {
            return stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
          } catch {
            return ''
          }
        },
        { timeout: 25_000 }
      )
      .toMatch(/\|\s*v1\s*\|\s*!\[[^\]]*]\([^)]+\)\s*\|/)
  })

  test('dragging the grip resizes the picture and the width reaches the file', async ({
    page,
    testVaultPath
  }) => {
    // #given a cell image with no size of its own. Every one of these is capped
    // at eight lines by the stylesheet, which is what keeps a screenshot from
    // blowing the row out — and what makes a per-image width worth having.
    const title = `Cell Resize ${Date.now()}`
    const ref = '../attachments/wide.png'
    fs.mkdirSync(path.join(testVaultPath, 'attachments'), { recursive: true })
    fs.writeFileSync(
      path.join(testVaultPath, 'attachments', 'wide.png'),
      Buffer.from(PNG_BASE64, 'base64')
    )
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Iteration | Shot |', '| --- | --- |', `| v1 | ![wide.png](${ref}) |`, ''].join('\n')
    )
    await openInEditor(page, title)

    const image = page.locator(`${SELECTORS.noteEditor} td img.inline-image`).first()
    await expect(image).toBeVisible({ timeout: 15_000 })

    // #when the grip on its inline-end edge is dragged out by 120px
    const wrap = page.locator(`${SELECTORS.noteEditor} td .inline-image-wrap`).first()
    await wrap.hover()
    const grip = wrap.locator('.inline-image-grip')
    const box = await grip.boundingBox()
    if (!box) throw new Error('resize grip has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()

    // #then the picture really grew…
    await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(100)

    // #and the width reaches the vault file as Obsidian's `|<width>` suffix,
    // escaped — a bare `|` there is the cell delimiter and would split the row
    await expect
      .poll(
        () => {
          try {
            return stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
          } catch {
            return ''
          }
        },
        { timeout: 25_000 }
      )
      .toMatch(/!\[wide\.png\\\|\d+]\(\.\.\/attachments\/wide\.png\)/)

    const body = stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
    // The row is still one row: the escape is what protects it.
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
  })

  test('pasting an image with the caret in a cell writes it into that cell', async ({
    page,
    testVaultPath
  }) => {
    // #given a table with an empty cell to paste into
    const title = `Cell Paste ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Iteration | Shot |', '| --- | --- |', '| v1 |  |', ''].join('\n')
    )
    await openInEditor(page, title)

    // #when the caret is put in the second cell and an image is pasted
    const cell = page.locator(`${SELECTORS.noteEditor} tbody td`).nth(1)
    await cell.click()
    await pasteImageAtCaret(page, PNG_BASE64, 'pasted.png')

    // #then the image lands INSIDE the cell — not as a block pushed out of the
    // table, which is what BlockNote's own paste handler does
    const cellImage = page.locator(`${SELECTORS.noteEditor} td img.inline-image`).first()
    await expect(cellImage).toBeVisible({ timeout: 20_000 })

    // #and it reaches the vault file as inline markdown in that row
    await expect
      .poll(
        () => {
          try {
            return stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
          } catch {
            return ''
          }
        },
        { timeout: 25_000 }
      )
      .toMatch(/\|\s*v1\s*\|\s*!\[[^\]]*]\([^)]+\)\s*\|/)

    const body = stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
    expect(body).not.toContain('memry-file://')
  })

  test('pasting an image that arrives as HTML with no file writes it into the cell', async ({
    page,
    testVaultPath
  }) => {
    // #given the gesture the file-only interceptor never saw: copying a picture
    // inside Memry, or out of a browser, Google Docs, Notion or Slack. Nothing
    // reaches the clipboard but `text/html` with an `<img>` in it, and the cell
    // stayed empty with no error to go on.
    const title = `Cell Html Paste ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Iteration | Shot |', '| --- | --- |', '| v1 |  |', ''].join('\n')
    )
    await openInEditor(page, title)

    // #when the caret is in the second cell and an image arrives as HTML only
    const cell = page.locator(`${SELECTORS.noteEditor} tbody td`).nth(1)
    await cell.click()
    await pasteHtmlAtCaret(page, `<img src="data:image/png;base64,${PNG_BASE64}" alt="grabbed">`)

    // #then the picture is IN the cell
    const cellImage = page.locator(`${SELECTORS.noteEditor} td img.inline-image`).first()
    await expect(cellImage).toBeVisible({ timeout: 20_000 })

    // #and no image block was pushed out beside the table
    const blockTypes = await page.evaluate(() =>
      (window as any).__memryEditor.document.map((block: any) => block.type as string)
    )
    expect(blockTypes).not.toContain('image')

    // #and the row on disk carries it as inline markdown
    await expect
      .poll(
        () => {
          try {
            return stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
          } catch {
            return ''
          }
        },
        { timeout: 25_000 }
      )
      .toMatch(/\|\s*v1\s*\|\s*!\[[^\]]*]\([^)]+\)\s*\|/)

    const body = stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
    // The bytes were saved as an attachment rather than inlined: a screenshot's
    // base64 in the row would be megabytes of the note's own markdown file.
    expect(body).not.toContain('data:image/png;base64')
    expect(body).not.toContain('memry-file://')
  })
})
