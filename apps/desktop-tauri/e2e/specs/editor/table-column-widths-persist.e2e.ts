// A dragged table column width survives leaving the note and a restart, ported from Electron's
// `table-column-widths-persist.e2e.ts` (Step 14k, #3531). GFM has nowhere to keep a width, so the
// save writes a `<!-- table-layout:… -->` marker in front of the table and the open reads it back.
import { noteBody, openNewNote } from '../../harness/editor'
import { NOTE_EDITOR, createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

const SEED_BODY = ['| Task | State |', '| --- | --- |', '| Shipping | Open |'].join('\n')
const DRAGGED_WIDTH = 220
const MARKER = `<!-- table-layout:{"columnWidths":[${DRAGGED_WIDTH},null]} -->`
const PERSIST_TIMEOUT_MS = 30_000

interface TableBlock {
  type: string
  content: { columnWidths?: unknown[] }
}
type EditorWindow = Window & {
  __memryActiveEditor?: {
    document: TableBlock[]
    updateBlock(block: TableBlock, update: { content: TableBlock['content'] }): void
  }
}

const columnWidths = (page: Page): Promise<unknown[] | null> =>
  page.evaluate(() => {
    const editor = (window as EditorWindow).__memryActiveEditor
    const table = editor?.document.find((block) => block.type === 'table')
    return table?.content.columnWidths ?? null
  })

/** What a column resize drag commits: the first column's width in the table's content. */
const setFirstColumnWidth = (page: Page, width: number): Promise<void> =>
  page.evaluate((next: number) => {
    const editor = (window as EditorWindow).__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const table = editor.document.find((block) => block.type === 'table')
    if (!table) throw new Error('seed body did not parse into a table')
    const widths = [...(table.content.columnWidths ?? [])]
    widths[0] = next
    editor.updateBlock(table, { content: { ...table.content, columnWidths: widths } })
  }, width)

test('a dragged column width survives leaving the note and restarting the app', async ({
  app,
  page
}) => {
  await vaultOpen(page)
  const resized = await openNewNote(page, `Resized Table ${Date.now()}`, SEED_BODY)
  const neighbour = await createNote(page, { title: `Neighbour ${Date.now()}`, content: 'Else' })
  await expect.poll(() => columnWidths(page), { timeout: PERSIST_TIMEOUT_MS }).toHaveLength(2)

  await setFirstColumnWidth(page, DRAGGED_WIDTH)
  await expect
    .poll(async () => (await noteBody(page, resized.id)) ?? '', { timeout: PERSIST_TIMEOUT_MS })
    .toContain(MARKER)

  await openFromSidebar(page, neighbour)
  await openFromSidebar(page, resized)
  await expect
    .poll(async () => (await columnWidths(page))?.[0], { timeout: PERSIST_TIMEOUT_MS })
    .toBe(DRAGGED_WIDTH)

  await restart(app)
  await vaultOpen(page)
  await openFromSidebar(page, resized)
  await expect
    .poll(async () => (await columnWidths(page))?.[0], { timeout: PERSIST_TIMEOUT_MS })
    .toBe(DRAGGED_WIDTH)

  const firstColumn = page.locator(`${NOTE_EDITOR} table col`).first()
  await expect(firstColumn).toHaveAttribute('style', `width: ${DRAGGED_WIDTH}px;`, {
    timeout: PERSIST_TIMEOUT_MS
  })
  // A `<col>` paints nothing; the width the user sees is the first header cell's.
  const firstCell = page.locator(`${NOTE_EDITOR} table tr`).first().locator('td, th').first()
  await expect
    .poll(
      async () => Math.abs(((await firstCell.boundingBox())?.width ?? 0) - DRAGGED_WIDTH) <= 2,
      { timeout: PERSIST_TIMEOUT_MS }
    )
    .toBe(true)
})
