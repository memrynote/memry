/**
 * G4 (#1641) — "I can't even cut and paste the text into the row and have to
 * re-write it."
 *
 * This lives in E2E rather than the renderer suite because the damage happens
 * inside a real clipboard round trip. jsdom has no `DataTransfer`, and its
 * HTML-paste path is inert, so a renderer test can pin the decision we make
 * (see `table-cell-paste.integration.test.ts`) but not the result a user sees.
 * Here the paste is a real `ClipboardEvent` carrying a real `DataTransfer`,
 * against the real editor, and the row is read back off disk afterwards.
 *
 * Everything here happens with the cursor inside a cell. A synthetic paste
 * aimed at an ordinary paragraph is a no-op — the default handler's markdown
 * path wants a trusted clipboard event — so the "outside a cell nothing
 * changes" half is asserted in the renderer test, where the handler's decision
 * can be read directly rather than inferred from the document.
 */

import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'

const TABLE_NOTE_BODY = [
  'Intro',
  '',
  '| Task    | Owner  |',
  '| ------- | ------ |',
  '| Ship it | Kaan   |',
  '| Review  | Nobody |',
  ''
].join('\n')

async function seedTableNote(page: Page, title: string): Promise<string> {
  const created = await page.evaluate(
    async ({ t, c }) => window.api.notes.create({ title: t, content: c }),
    { t: title, c: TABLE_NOTE_BODY }
  )
  const id = created?.note?.id
  if (!id) throw new Error(`could not seed "${title}"`)
  return id
}

async function openTableNote(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
  // The table has to be in the editor's own document, not just the DOM, before
  // a paste can be aimed at one of its cells.
  await expect
    .poll(() => tableCells(page), { timeout: 20_000 })
    .toEqual([
      ['Task', 'Owner'],
      ['Ship it', 'Kaan'],
      ['Review', 'Nobody']
    ])
}

/** The table's cells as plain strings, row by row. */
async function tableCells(page: Page): Promise<string[][] | null> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) return null
    const table = editor.document.find((block: any) => block.type === 'table')
    if (!table) return null
    return table.content.rows.map((row: any) =>
      row.cells.map((cell: any) =>
        (cell.content ?? [])
          .map((inline: any) => (inline.type === 'text' ? inline.text : `<${inline.type}>`))
          .join('')
      )
    )
  })
}

/**
 * Drive the cursor the way a user does — click the cell, then walk to the end
 * of its line. Reaching into ProseMirror to set a position would skip the very
 * layer (focus, DOM selection) that the paste handler reads.
 */
function cell(page: Page, text: string): Locator {
  return page
    .locator(`${SELECTORS.noteEditor} td, ${SELECTORS.noteEditor} th`)
    .filter({ hasText: text })
    .first()
}

async function placeCursorAtEndOf(page: Page, cellText: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await cell(page, cellText).click()
        await page.keyboard.press('End')
        return page.evaluate(() => {
          const view = (window as any).__memryEditor?.prosemirrorView
          return view ? (view.state.selection.$from.parent.textContent as string) : ''
        })
      },
      { message: `cursor inside the "${cellText}" cell`, timeout: 10_000 }
    )
    .toBe(cellText)
}

/**
 * BlockNote's copy handler bails out when the DOM selection is collapsed, so a
 * cut fired before the selection lands is silently a no-op. Repeat the gesture
 * until the browser agrees the text is selected.
 *
 * The selection is read a beat after the keys, not in the same tick: measured,
 * `Shift+End` lands in the DOM before ProseMirror has taken it into its own
 * state, and in that window the DOM selection reads as the whole rest of the
 * block while the editor still thinks the cursor is collapsed. Both have to
 * agree before a cut can do anything.
 */
async function selectCellText(page: Page, cellText: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await cell(page, cellText).click()
        await page.keyboard.press('Home')
        await page.keyboard.press('Shift+End')
        await page.waitForTimeout(150)
        return page.evaluate(() => {
          const view = (window as any).__memryEditor?.prosemirrorView
          const { from, to } = view?.state.selection ?? {}
          return {
            dom: window.getSelection()?.toString() ?? '',
            editor: view ? (view.state.doc.textBetween(from, to, ' ') as string) : ''
          }
        })
      },
      { message: `DOM selection over "${cellText}"`, timeout: 10_000 }
    )
    .toEqual({ dom: cellText, editor: cellText })
}

async function pastePlainText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const view = (window as any).__memryEditor?.prosemirrorView
    if (!view) throw new Error('window.__memryEditor not exposed')
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', value)
    view.dom.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  }, text)
}

/**
 * Cut whatever is selected, then paste it at the current cursor. Both events
 * carry the same `DataTransfer`, which is exactly how the browser hands the
 * clipboard from one to the other.
 */
async function cutSelection(page: Page): Promise<void> {
  const flavours = await page.evaluate(() => {
    const view = (window as any).__memryEditor?.prosemirrorView
    const clipboardData = new DataTransfer()
    ;(window as any).__memryE2EClipboard = clipboardData
    view.dom.dispatchEvent(
      new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData })
    )
    return [...clipboardData.types]
  })
  // An empty clipboard here means the cut never fired, and the paste that
  // follows would then assert against an unchanged table.
  expect(flavours).toContain('blocknote/html')
}

async function pasteCutSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = (window as any).__memryEditor?.prosemirrorView
    const clipboardData = (window as any).__memryE2EClipboard
    if (!clipboardData) throw new Error('nothing was cut')
    view.dom.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  })
}

async function savedBody(page: Page, noteId: string): Promise<string> {
  const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
  return note?.content ?? ''
}

/** How many columns the markdown row starting with `prefix` carries. */
function columnCount(markdown: string, prefix: string): number {
  const row = markdown.split('\n').find((line) => line.trimStart().startsWith(prefix))
  if (!row) throw new Error(`no markdown row starts with "${prefix}"`)
  return row.split('|').slice(1, -1).length
}

test.describe('Pasting into a table cell', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('keeps the row when the pasted text looks like a markdown table', async ({ page }) => {
    const title = uniqueLabel('Table Paste Markdown')
    const noteId = await seedTableNote(page, title)
    await openTableNote(page, title)

    await placeCursorAtEndOf(page, 'Nobody')
    // Read as markdown this is a 2x2 table of its own. Before #1641 it was
    // spliced into the row: "Nobody" vanished and a third column appeared.
    await pastePlainText(page, '| alpha | beta |\n| - | - |\n| 1 | 2 |')

    const cells = await tableCells(page)
    expect(cells).toHaveLength(3)
    expect(cells?.every((row) => row.length === 2)).toBe(true)
    expect(cells?.[2][1]).toContain('Nobody')
    expect(cells?.[2][1]).toContain('| alpha | beta |')

    // And it is still a two-column table once it lands on disk.
    await expect
      .poll(() => savedBody(page, noteId), { message: 'note body on disk', timeout: 20_000 })
      .toContain('alpha')
    const body = await savedBody(page, noteId)
    expect(body).toContain('Nobody')
    expect(columnCount(body, '| Task')).toBe(2)
  })

  test('keeps multi-line text inside the one cell', async ({ page }) => {
    const title = uniqueLabel('Table Paste Multiline')
    const noteId = await seedTableNote(page, title)
    await openTableNote(page, title)

    await placeCursorAtEndOf(page, 'Review')
    await pastePlainText(page, ' first\nsecond')

    const cells = await tableCells(page)
    expect(cells).toHaveLength(3)
    expect(cells?.every((row) => row.length === 2)).toBe(true)
    expect(cells?.[2][0]).toContain('first')
    expect(cells?.[2][0]).toContain('second')

    // A markdown row is one line, so the newline becomes a space on disk —
    // lossy, but the text is all still there and the table is still a table.
    await expect
      .poll(() => savedBody(page, noteId), { message: 'note body on disk', timeout: 20_000 })
      .toContain('second')
    const body = await savedBody(page, noteId)
    expect(body).toMatch(/\|\s*Review first second\s*\|\s*Nobody\s*\|/)
  })

  test('moves text from one cell into another on cut and paste', async ({ page }) => {
    const title = uniqueLabel('Table Paste Cut')
    const noteId = await seedTableNote(page, title)
    await openTableNote(page, title)

    await selectCellText(page, 'Nobody')
    await cutSelection(page)
    await expect.poll(async () => (await tableCells(page))?.[2][1], { timeout: 10_000 }).toBe('')

    await placeCursorAtEndOf(page, 'Kaan')
    await pasteCutSelection(page)

    await expect
      .poll(() => tableCells(page), { timeout: 10_000 })
      .toEqual([
        ['Task', 'Owner'],
        ['Ship it', 'KaanNobody'],
        ['Review', '']
      ])

    await expect
      .poll(() => savedBody(page, noteId), { message: 'note body on disk', timeout: 20_000 })
      .toContain('KaanNobody')
  })
})
