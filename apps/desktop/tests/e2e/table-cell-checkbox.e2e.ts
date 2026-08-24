// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Checkboxes inside table cells — the real app.
 *
 * "They are still not allowing images to paste into a cell or recognizing
 * checklists." A `tableCell` is `content: "tableContent+"` over a
 * `tableParagraph` that is `inline*`, and `checkListItem` is a BLOCK — so a
 * tickable box in a cell was unreachable from every direction at once: the
 * `[ ] ` input rule never fired (BlockNote bails when the cursor block's schema
 * content is not `"inline"`, and inside a cell that block is the TABLE),
 * `/check` inserted the checklist AFTER the table, and the toolbar toggle
 * filtered the table block out and silently did nothing.
 *
 * The unit suites cover each half (`inline-checkbox.test.ts`,
 * `inline-checkbox-plugin.test.ts`, `inline-checkbox-utils.test.ts`,
 * `blocknote-converter.test.ts`); none of them can run the loop the user walks
 * — a real editor, a real click on an atom rendered `contenteditable="false"`,
 * and the debounced write-back landing real bytes on disk. That loop is what
 * this file drives, and the vault file is what it reads.
 */

import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { waitForAppReady, waitForVaultReady, SELECTORS } from './utils/electron-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'

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

function readBody(absPath: string): string {
  try {
    return stripFrontmatter(fs.readFileSync(absPath, 'utf8'))
  } catch {
    return ''
  }
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

const cellCheckbox = (page: Page) =>
  page.locator(`${SELECTORS.noteEditor} td .inline-checkbox input`).first()

test.describe('Table cell checkboxes', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('typing `[ ] task` in a cell makes a checkbox that ticks and reaches disk', async ({
    page,
    testVaultPath
  }) => {
    // #given an empty cell in a table. This is the gesture the report is about:
    // before this, `[ ] ` in a cell stayed four literal characters forever.
    const title = `Cell Checkbox ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Item | Done |', '| --- | --- |', '| ship |  |', ''].join('\n')
    )
    await openInEditor(page, title)

    // #when the user types the token and a label into the second cell
    const cell = page.locator(`${SELECTORS.noteEditor} tbody td`).nth(1)
    await cell.click()
    await page.keyboard.type('[ ] task')

    // #then a real checkbox is in the cell, not text
    await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })
    await expect(cellCheckbox(page)).not.toBeChecked()

    // #and no checklist block was added beside the table, which is the old bug
    const blockTypes = await page.evaluate(() =>
      (window as any).__memryEditor.document.map((block: any) => block.type as string)
    )
    expect(blockTypes).not.toContain('checkListItem')

    // #when the box is clicked. A real click, not a synthetic one: the node is
    // an atom rendered `contenteditable="false"`, which is exactly the shape
    // whose `click` the browser retargeted away from the wiki-link chip.
    await cellCheckbox(page).click()

    // #then it ticks…
    await expect(cellCheckbox(page)).toBeChecked({ timeout: 10_000 })

    // …and the row reaches the vault file as a ticked GFM-style token. The
    // space between the box and the label is the load-bearing part: a bare
    // `<input>` serializes to `[x]task`, with no gap.
    await expect.poll(() => readBody(absPath), { timeout: 25_000 }).toMatch(/\|\s*\[x] task\s*\|/)

    // #and the table is still a table — a claimed `<td>` would have eaten it
    const body = readBody(absPath)
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
  })

  test('a checkbox written into a cell on disk opens as one and is not rewritten', async ({
    page,
    testVaultPath
  }) => {
    // #given a vault someone wrote by hand (or in Obsidian). `[ ]` in a cell is
    // literal text to every markdown parser — GFM's task-list syntax is
    // list-item only — so the renderer's promoter is the only thing that can
    // turn it back into a control.
    const title = `Cell Checkbox Disk ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Item | Done |', '| --- | --- |', '| ship | [ ] task |', ''].join('\n')
    )

    // #when the note is opened in the real editor
    await openInEditor(page, title)

    // #then the box is a box
    await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })
    await expect(cellCheckbox(page)).not.toBeChecked()

    // #and the file is not rewritten: write-back byte-compares, so drift here
    // would rewrite every note holding one on every open
    await retriggerSave(page)
    const body = readBody(absPath)
    expect(body).toMatch(/\|\s*ship\s*\|\s*\[ ] task\s*\|/)
    expect(body).not.toContain('<input')
    expect(body.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3)
  })

  test('choosing Check List from the slash menu puts the box in the cell', async ({
    page,
    testVaultPath
  }) => {
    // #given the other gesture people reach for. Before this, `/check` in a cell
    // inserted a checklist BLOCK after the whole table and took the caret with
    // it — the cell stayed empty.
    const title = `Cell Checkbox Slash ${Date.now()}`
    const absPath = seedVaultFile(
      testVaultPath,
      title,
      ['| Item | Done |', '| --- | --- |', '| ship |  |', ''].join('\n')
    )
    await openInEditor(page, title)

    // #when
    const cell = page.locator(`${SELECTORS.noteEditor} tbody td`).nth(1)
    await cell.click()
    await page.keyboard.type('/check')
    await expect(page.getByText('Check List', { exact: true }).first()).toBeVisible({
      timeout: 10_000
    })
    await page.keyboard.press('Enter')

    // #then the box is IN the cell…
    await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })

    // …and no checklist block was added beside the table
    const blockTypes = await page.evaluate(() =>
      (window as any).__memryEditor.document.map((block: any) => block.type as string)
    )
    expect(blockTypes).not.toContain('checkListItem')

    // #and the row on disk carries the token
    await expect.poll(() => readBody(absPath), { timeout: 25_000 }).toMatch(/\|\s*\[ ]\s*\|/)
  })
})
