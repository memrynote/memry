// Checkboxes inside table cells, ported from Electron's `table-cell-checkbox.e2e.ts` (Step 14k,
// #3531). A cell holds inline content only and `checkListItem` is a block, so a box in a cell was
// unreachable: the `[ ] ` input rule never fired, `/check` put a checklist after the table, and
// the toolbar did nothing. The inline checkbox node fixes each; this drives the real editor, a
// click on the `contenteditable="false"` atom, and the write-back to the vault file.
import { typeInEditor } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { blockTypes, openTableNote, tableLines, vaultBody } from '../../harness/table'
import { test, expect } from '../../harness/test'

const cellCheckbox = (page: Page) =>
  page.locator(`${NOTE_EDITOR} td .inline-checkbox input`).first()

const EMPTY_CELL = ['| Item | Done |', '| --- | --- |', '| ship |  |', ''].join('\n')
const EMPTY_CELLS = [
  ['Item', 'Done'],
  ['ship', '']
]

/** Clicks the second body cell until the editor's caret is in it. */
async function caretInDoneCell(page: Page): Promise<void> {
  const cell = page.locator(`${NOTE_EDITOR} tbody td`).nth(1)
  await expect
    .poll(async () => {
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
    })
    .toBe(true)
}

test('typing `[ ] task` in a cell makes a checkbox that ticks and reaches disk', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await openTableNote(page, `Cell Checkbox ${Date.now()}`, EMPTY_CELL, EMPTY_CELLS)

  await caretInDoneCell(page)
  await typeInEditor(page, '[ ] task')

  await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })
  await expect(cellCheckbox(page)).not.toBeChecked()
  // No checklist block beside the table, the old bug.
  expect(await blockTypes(page)).not.toContain('checkListItem')

  // A real click on the atom, the shape whose click the browser retargeted away from a chip.
  await cellCheckbox(page).click()
  await expect(cellCheckbox(page)).toBeChecked({ timeout: 10_000 })

  // The space between box and label is load-bearing: a bare `<input>` serializes to `[x]task`.
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(/\|\s*\[x] task\s*\|/)
  expect(tableLines(vaultBody(testVaultPath, note.path))).toHaveLength(3)
})

test('a checkbox written into a cell on disk opens as one and is not rewritten', async ({
  page,
  testVaultPath
}) => {
  // `[ ]` in a cell is literal text to every markdown parser, so the renderer is what promotes it.
  await vaultOpen(page)
  const body = ['| Item | Done |', '| --- | --- |', '| ship | [ ] task |', ''].join('\n')
  const note = await openTableNote(page, `Cell Checkbox Disk ${Date.now()}`, body, null)

  await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })
  await expect(cellCheckbox(page)).not.toBeChecked()

  // Write-back byte-compares, so drift here would rewrite every such note on every open. An edit
  // elsewhere, undone, makes the editor serialize the document again.
  await page.locator(NOTE_EDITOR).getByText('Item', { exact: true }).click()
  await typeInEditor(page, 'x')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(2500)
  const saved = vaultBody(testVaultPath, note.path)
  expect(saved).toMatch(/\|\s*ship\s*\|\s*\[ ] task\s*\|/)
  expect(saved).not.toContain('<input')
  expect(tableLines(saved)).toHaveLength(3)
})

test('choosing Check List from the slash menu puts the box in the cell', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await openTableNote(
    page,
    `Cell Checkbox Slash ${Date.now()}`,
    EMPTY_CELL,
    EMPTY_CELLS
  )

  await caretInDoneCell(page)
  await typeInEditor(page, '/check')
  // Enter runs the highlighted row of the last query the menu loaded, and a shorter query lists
  // Check List too, so a wait on its text alone can let Enter run another row (windows-x64, run
  // 42974914462).
  await expect(
    page
      .locator('.memry-slash-menu [role="option"][aria-selected="true"]')
      .filter({ hasText: 'Check List' })
  ).toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('Enter')

  await expect(cellCheckbox(page)).toBeVisible({ timeout: 15_000 })
  expect(await blockTypes(page)).not.toContain('checkListItem')
  await expect
    .poll(() => vaultBody(testVaultPath, note.path), { timeout: 25_000 })
    .toMatch(/\|\s*\[ ]\s*\|/)
})
