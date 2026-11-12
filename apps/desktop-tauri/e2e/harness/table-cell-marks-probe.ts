// TEMPORARY FLAKE-7D probe: the bold/italic case of table-cell-colors.e2e.ts, repeated, with the
// page's focus, selection and transactions logged and dumped when a poll runs out.
import { noteBody, openNewNote, setBlocks } from './editor'
import { cellState, installProbe, probeLog } from './flake-probe'
import { NOTE_EDITOR, openFromSidebar, vaultOpen } from './notes'
import type { Locator } from './pw-compat/locator'
import type { Page } from './pw-compat/page'
import { tableBlock } from './table'
import { test, expect } from './test'
import { invoke } from './vault-commands'

const TABLE_DOC = [
  tableBlock([
    ['Task', 'State'],
    ['Shipping', 'Open']
  ])
]
const IN_CELL = { x: 20, y: 20 }

async function selectWordInCell(page: Page, cell: Locator, word: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await cell.click({ position: IN_CELL })
        await cell.evaluate((element: HTMLElement, text: string) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.textContent?.indexOf(text) ?? -1
            if (at >= 0) {
              window.getSelection()?.setBaseAndExtent(node, at, node, at + text.length)
              return
            }
          }
        }, word)
        await page.waitForTimeout(100)
        return page.evaluate(
          () =>
            (
              window as unknown as { __memryActiveEditor?: { getSelectedText(): string } }
            ).__memryActiveEditor?.getSelectedText() ?? ''
        )
      },
      { timeout: 20_000 }
    )
    .toBe(word)
}

async function reopen(page: Page, note: { id: string; path: string; title: string }) {
  await page.reload()
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function untilContains(
  page: Page,
  id: string,
  needle: string,
  stage: string,
  before: string
) {
  try {
    await expect
      .poll(async () => (await noteBody(page, id)) ?? '', { timeout: 20_000 })
      .toContain(needle)
  } catch (error) {
    throw new Error(
      `${String(error)}\nPROBE stage=${stage}\nPROBE before=${before}\nPROBE after=${await cellState(page)}\nPROBE ${await probeLog(page)}`,
      { cause: error }
    )
  }
}

export function defineMarksProbe(tag: string, reps: number): void {
  for (let rep = 0; rep < reps; rep++) {
    test(`PROBE ${tag}${rep} bold and italic applied inside a cell reach the file`, async ({
      page
    }) => {
      await vaultOpen(page)
      const note = await openNewNote(page, `Table Cell Marks ${Date.now()}`, 'seed')
      await setBlocks(page, TABLE_DOC)

      await installProbe(page)
      await selectWordInCell(page, page.locator(`${NOTE_EDITOR} td`).first(), 'Shipping')
      const bold = page.locator('[data-test="bold"]').first()
      await expect(bold).toBeVisible({ timeout: 10_000 })
      const boldBefore = await cellState(page)
      await bold.click()
      await untilContains(page, note.id, '**Shipping**', 'bold', boldBefore)

      await invoke(page, 'settings_set_group', {
        group: 'editor',
        patch: { toolbarMode: 'sticky' }
      })
      await reopen(page, note)

      await installProbe(page)
      await selectWordInCell(page, page.locator(`${NOTE_EDITOR} td`).nth(1), 'Open')
      const italicBefore = await cellState(page)
      await page.keyboard.press('ControlOrMeta+i')
      await untilContains(page, note.id, '*Open*', 'italic', italicBefore)
      expect(await noteBody(page, note.id)).toContain('**Shipping**')
    })
  }
}
