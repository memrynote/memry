// Wiki links inside table cells (#1865), ported from Electron's `table-cell-wiki-link.e2e.ts`
// (Step 14k, #3531). BlockNote's HTML exporter never reaches inside a table: a row resolves
// through `NodeSpec.toDOM`, the editor's rich chip, so `[[Roadmap]]` in a cell was written back as
// bare `Roadmap`. A note's write-back goes through the CRDT converter, which was never affected;
// the template editor, mounted with no note id, still saves through the renderer serializer, and
// is the surface that goes red without the fix.
import { typeInEditor } from '../../harness/editor'
import {
  NOTE_EDITOR,
  NOTE_TITLE,
  createNote,
  getNote,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { tableLines } from '../../harness/table'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

/** The stored template body, read from `data.db` through the command. */
async function templateContent(page: Page, id: string): Promise<string> {
  const template = await invoke<{ content?: string } | null>(page, 'templates_get', { id })
  return template?.content ?? ''
}

/** Settings › Editor › Templates, then the template's row, as a user reaches its editor. */
async function openTemplateEditor(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const row = page.getByRole('button', { name, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
}

test('editing a template does not strip the wiki link out of its table', async ({ page }) => {
  await vaultOpen(page)
  // The link and the edit are in different blocks: the wiki-link edit plugin un-promotes the chip
  // under the caret, so typing in the cell would test the plugin, not the serializer.
  const target = label('Some Target')
  const name = label('Table Template')
  const marker = 'edited-in-e2e'
  const seeded = [
    '| Area | Owner |',
    '| --- | --- |',
    `| Q3 | [[${target}]] |`,
    '',
    'Notes below.'
  ].join('\n')
  const template = await invoke<{ id: string }>(page, 'templates_create', {
    input: { name, content: seeded }
  })

  await openTemplateEditor(page, name)
  // The link became a node; without it the rest would pass on text that was never at risk.
  await expect(
    page.locator(`${NOTE_EDITOR} td [data-wiki-link][data-target="${target}"]`)
  ).toBeVisible({ timeout: 15_000 })

  // Any edit serializes the whole document, table included.
  await page.locator(NOTE_EDITOR).getByText('Notes below.').click()
  await page.keyboard.press('End')
  await typeInEditor(page, ` ${marker}`)

  // Polling on the marker proves the debounced save ran before the link is read.
  await expect.poll(() => templateContent(page, template.id), { timeout: 30_000 }).toContain(marker)
  const content = await templateContent(page, template.id)
  expect(content).toContain(`[[${target}]]`)
  expect(content).toMatch(new RegExp(`\\|\\s*Q3\\s*\\|\\s*\\[\\[${target}\\]\\]\\s*\\|`))
  // Still one table: a chip serialized as block HTML would split the row or swallow the table.
  expect(tableLines(content)).toHaveLength(3)
})

// Passes on the pre-#1865 build too (a note saves through the CRDT converter); it pins what the
// report is made of on a path with no other coverage: the cell holds a chip, and pressing it goes
// to the note it names.
test('a wiki link in a note table is a chip and follows to its target', async ({ page }) => {
  await vaultOpen(page)
  const target = label('Table Target')
  await createNote(page, { title: target, content: 'A target.\n' })
  const source = await createNote(page, {
    title: label('Table Source'),
    content: ['| Area | Owner |', '| --- | --- |', `| Q3 | [[${target}]] |`, ''].join('\n')
  })
  // Read back: had the create flattened the link, everything below would prove nothing.
  expect((await getNote(page, source.id))?.content).toContain(`[[${target}]]`)

  await openFromSidebar(page, source)
  const chip = page.locator(`${NOTE_EDITOR} td [data-wiki-link][data-target="${target}"]`)
  await expect(chip).toBeVisible({ timeout: 20_000 })

  // Held, not clicked: a hand holds 80 to 150 ms, and in that window the edit plugin paints the
  // raw `[[…]]` over the chip and hides it, so the click lands nowhere. Read, release, then
  // assert, so a failure leaves no button held.
  await chip.hover()
  await page.mouse.down()
  await page.waitForTimeout(150)
  const chipStillRendered = await chip.isVisible()
  await page.mouse.up()

  expect(chipStillRendered).toBe(true)
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(target)
})
