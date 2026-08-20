// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * A table cell's colour has to still be there after the note is saved (#1639).
 *
 * Two things were wrong. BlockNote 0.47 defaults `tables.cellBackgroundColor`
 * and `tables.cellTextColor` to false, and with both off it renders no cell
 * handle at all — so a table was the one place in a note where colour could not
 * be reached. And a GFM row has nowhere to keep a cell's colour, so simply
 * turning the menu on would have shipped a control whose result vanished on the
 * next open. The colour is written as a `<!-- table-colors:… -->` marker line
 * in front of the table, the same way a block's own colour already was.
 *
 * These run on the single-app fixture, which is the NON-collaborative save path
 * (`markdown-utils.ts`). Its twin, the CRDT/sync path
 * (`blocknote-converter.ts`), is pinned by unit tests that drive a real
 * ServerBlockNoteEditor through markdown → Y.Doc → markdown.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { getNoteFileBodyById, openNoteByHandle, openNoteByTitle } from './utils/note-sync-helpers'

const cell = (text: string) => ({
  type: 'tableCell',
  content: [{ type: 'text', text, styles: {} }],
  props: { colspan: 1, rowspan: 1 }
})

/** A two-column table with one header row — what `/table` inserts. */
const TABLE_DOC = [
  {
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [null, null],
      headerRows: 1,
      rows: [{ cells: [cell('Task'), cell('State')] }, { cells: [cell('Shipping'), cell('Open')] }]
    }
  }
]

const TABLE_MD = ['| Task | State |', '| --- | --- |', '| Shipping | Open |'].join('\n')

/**
 * Where to double-click inside a cell to select its first word.
 *
 * Not the centre: a cell is a fixed 120px wide, a short word leaves the middle
 * empty, and a double-click on empty cell space selects nothing. Not the very
 * corner either — the block drag handle overhangs the first column there.
 */
const WORD_START = { x: 20, y: 20 }

async function createNote(page: Page, title: string, content = '') {
  return page.evaluate(
    async ({ noteTitle, noteContent }) => {
      const result = await window.api.notes.create({ title: noteTitle, content: noteContent })
      if (!result.success || !result.note) throw new Error(result.error || 'note create failed')
      return { id: result.note.id, title: result.note.title, emoji: result.note.emoji ?? null }
    },
    { noteTitle: title, noteContent: content }
  )
}

async function waitForEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  return editor
}

async function setDocument(page: Page, blocks: unknown[]): Promise<void> {
  await waitForEditor(page)
  await page.evaluate((next) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, next)
  }, blocks)
}

/** Every cell as {text, textColor, backgroundColor}, row by row. */
async function tableShape(page: Page): Promise<unknown[]> {
  await waitForEditor(page)
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const table = editor.document.find((block: any) => block.type === 'table')
    if (!table) throw new Error('no table in the document')
    return table.content.rows.map((row: any) =>
      row.cells.map((cellValue: any) => ({
        text: (cellValue.content ?? []).map((part: any) => part.text ?? '').join(''),
        textColor: cellValue.props?.textColor,
        backgroundColor: cellValue.props?.backgroundColor
      }))
    )
  })
}

test.describe('Table cell colours E2E (#1639)', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a cell coloured from the cell menu is still coloured after a reopen', async ({ page }) => {
    // #given a note holding a table
    const title = `Table Cell Colour ${Date.now()}`
    const note = await createNote(page, title)
    await openNoteByHandle(page, note)
    await setDocument(page, TABLE_DOC)

    // #when the body cell is coloured through the menu the flags unlock —
    // with both off BlockNote renders no cell handle at all, so this hover
    // finding one is itself the assertion that they are on
    const bodyCell = page.locator(`${SELECTORS.noteEditor} td`).first()
    await bodyCell.hover()
    const cellHandle = page.locator('[data-test="tableCellHandle"]').first()
    await expect(cellHandle).toBeVisible({ timeout: 10_000 })
    await cellHandle.click()
    await page.getByText('Colors', { exact: true }).first().click()
    await page.locator('[data-test="background-color-red"]').first().click()

    // #then the colour reaches the vault file as a marker in front of the table
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('<!-- table-colors:')
    const saved = await getNoteFileBodyById(page, note.id)
    expect(saved).toContain('"1:0":{"backgroundColor":"red"}')
    expect(saved).toContain('| Shipping')

    // #and it is still there when the note is opened cold
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await ready(page)
    await openNoteByTitle(page, title)

    await expect.poll(async () => (await tableShape(page))[1][0].backgroundColor).toBe('red')
    expect((await tableShape(page))[0][0].backgroundColor).not.toBe('red')

    // #and reopening rewrote nothing: the round trip converged on the first save
    expect(await getNoteFileBodyById(page, note.id)).toBe(saved)
  })

  test('a table whose marker was written by hand opens coloured and is not rewritten', async ({
    page
  }) => {
    // #given a note whose bytes the editor never produced — the marker and the
    // table went into the vault file as text, exactly as another editor would
    // have left them
    const title = `Table Colour Marker ${Date.now()}`
    const body = `<!-- table-colors:{"1:1":{"textColor":"blue"}} -->\n${TABLE_MD}`
    const note = await createNote(page, title, body)
    await openNoteByHandle(page, note)

    // #then the colour is on the cell the marker names, and only that one
    await expect.poll(async () => (await tableShape(page))[1][1].textColor).toBe('blue')
    const shape = await tableShape(page)
    expect(shape[1][0].textColor).not.toBe('blue')

    // #and the marker line is not sitting in the note as a paragraph
    expect(shape[1][1].text).toBe('Open')

    // #and the file is left exactly as it was found
    expect(await getNoteFileBodyById(page, note.id)).toBe(body)
  })

  test('bold and italic applied inside a cell reach the file, in both toolbar modes', async ({
    page
  }) => {
    // #given a note holding a table, on the default floating toolbar
    const title = `Table Cell Marks ${Date.now()}`
    const note = await createNote(page, title)
    await openNoteByHandle(page, note)
    await setDocument(page, TABLE_DOC)

    // #when the word in the body cell is selected and bolded from the toolbar.
    // The double-click is aimed near the start of the cell rather than its
    // centre: a cell is a fixed 120px wide and a short word leaves the middle
    // of it empty, where a double-click selects nothing at all.
    const bodyCell = page.locator(`${SELECTORS.noteEditor} td`).first()
    await bodyCell.dblclick({ position: WORD_START })
    const boldButton = page.locator('[data-test="bold"]').first()
    await expect(boldButton).toBeVisible({ timeout: 10_000 })
    await boldButton.click()

    // #then the mark reaches the file — markdown carries it natively, no marker
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('**Shipping**')

    // #when the same is done with the sticky toolbar on, via the keyboard
    await page.evaluate(async () => {
      await window.api.settings.setEditorSettings({ toolbarMode: 'sticky' })
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await ready(page)
    await openNoteByTitle(page, title)

    const stateCell = page.locator(`${SELECTORS.noteEditor} td`).nth(1)
    await stateCell.dblclick({ position: WORD_START })
    await page.keyboard.press('ControlOrMeta+i')

    // #then that mark lands too
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('*Open*')
    expect(await getNoteFileBodyById(page, note.id)).toContain('**Shipping**')
  })
})
