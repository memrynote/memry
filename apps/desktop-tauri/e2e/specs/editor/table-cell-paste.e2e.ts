// Pasting into a table cell keeps the row (#1641), ported from Electron's
// `table-cell-paste.e2e.ts` (Step 14k, #3531). The paste is a real `ClipboardEvent` carrying a
// real `DataTransfer` against the real editor, with the caret put in the cell by a click, and the
// row is read back from the saved note. Outside a cell a synthetic paste is a no-op (the default
// handler wants a trusted event), so that half stays in the renderer test.
import { noteBody } from '../../harness/editor'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { cellByText, openTableNote, tableCells } from '../../harness/table'
import { test, expect } from '../../harness/test'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

interface View {
  dom: HTMLElement
  state: {
    selection: {
      from: number
      to: number
      $from: { parentOffset: number; parent: { textContent: string } }
    }
    doc: { textBetween(from: number, to: number, separator: string): string }
  }
}
type ViewWindow = Window & {
  __memryActiveEditor?: { prosemirrorView?: View }
  __memryE2EClipboard?: DataTransfer
}

/**
 * Clicks the cell, then puts the DOM caret at the end of its text, until the editor's own caret
 * stands there collapsed. After Electron's click and End through the driver, the paste replaced
 * the cell's text in WKWebView instead of following it.
 */
async function placeCursorAtEndOf(page: Page, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await cellByText(page, text).click()
        await cellByText(page, text).evaluate((cell: HTMLElement, value: string) => {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent === value) {
              window.getSelection()?.collapse(node, value.length)
              return
            }
          }
        }, text)
        await page.waitForTimeout(100)
        return page.evaluate(() => {
          const selection = (window as ViewWindow).__memryActiveEditor?.prosemirrorView?.state
            .selection
          if (!selection || selection.from !== selection.to) return null
          return {
            text: selection.$from.parent.textContent,
            offset: selection.$from.parentOffset
          }
        })
      },
      { timeout: 10_000 }
    )
    .toEqual({ text, offset: text.length })
}

/**
 * Selects the cell's text and waits until the DOM and the editor agree on it: BlockNote's copy
 * handler bails on a collapsed DOM selection, and ProseMirror takes the DOM's a beat later. The
 * selection is set on the DOM because the driver's Shift+End reaches the page without Shift.
 */
async function selectCellText(page: Page, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await cellByText(page, text).click()
        await cellByText(page, text).evaluate((cell: HTMLElement, value: string) => {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent === value) {
              window.getSelection()?.setBaseAndExtent(node, 0, node, value.length)
              return
            }
          }
        }, text)
        await page.waitForTimeout(150)
        return page.evaluate(() => {
          const view = (window as ViewWindow).__memryActiveEditor?.prosemirrorView
          const selection = view?.state.selection
          return {
            dom: window.getSelection()?.toString() ?? '',
            editor:
              view && selection ? view.state.doc.textBetween(selection.from, selection.to, ' ') : ''
          }
        })
      },
      { timeout: 10_000 }
    )
    .toEqual({ dom: text, editor: text })
}

const pastePlainText = (page: Page, text: string): Promise<void> =>
  page.evaluate((value: string) => {
    const view = (window as ViewWindow).__memryActiveEditor?.prosemirrorView
    if (!view) throw new Error('window.__memryActiveEditor not exposed')
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', value)
    view.dom.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  }, text)

/** Cuts the selection into a `DataTransfer` the paste reuses, as the browser hands it over. */
async function cutSelection(page: Page): Promise<void> {
  const flavours = await page.evaluate(() => {
    const target = window as ViewWindow
    const view = target.__memryActiveEditor?.prosemirrorView
    if (!view) throw new Error('window.__memryActiveEditor not exposed')
    const clipboardData = new DataTransfer()
    target.__memryE2EClipboard = clipboardData
    view.dom.dispatchEvent(
      new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData })
    )
    return [...clipboardData.types]
  })
  // An empty clipboard means the cut never ran, and the paste would assert an unchanged table.
  expect(flavours).toContain('blocknote/html')
}

const pasteCutSelection = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const target = window as ViewWindow
    const view = target.__memryActiveEditor?.prosemirrorView
    const clipboardData = target.__memryE2EClipboard
    if (!view || !clipboardData) throw new Error('nothing was cut')
    view.dom.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  })

const savedBody = async (page: Page, id: string): Promise<string> =>
  (await noteBody(page, id)) ?? ''

/** How many columns the markdown row starting with `prefix` has. */
function columnCount(markdown: string, prefix: string): number {
  const row = markdown.split('\n').find((line) => line.trimStart().startsWith(prefix))
  if (!row) throw new Error(`no markdown row starts with "${prefix}"`)
  return row.split('|').slice(1, -1).length
}

test('keeps the row when the pasted text looks like a markdown table', async ({ page }) => {
  await vaultOpen(page)
  const note = await openTableNote(page, label('Table Paste Markdown'))

  await placeCursorAtEndOf(page, 'Nobody')
  // A 2x2 table of its own as markdown. Before #1641 it was spliced into the row: "Nobody"
  // vanished and a third column appeared.
  await pastePlainText(page, '| alpha | beta |\n| - | - |\n| 1 | 2 |')

  const cells = await tableCells(page)
  expect(cells).toHaveLength(3)
  expect(cells?.every((row) => row.length === 2)).toBe(true)
  expect(cells?.[2][1]).toContain('Nobody')
  expect(cells?.[2][1]).toContain('| alpha | beta |')

  await expect.poll(() => savedBody(page, note.id), { timeout: 20_000 }).toContain('alpha')
  const body = await savedBody(page, note.id)
  expect(body).toContain('Nobody')
  expect(columnCount(body, '| Task')).toBe(2)
})

test('keeps multi-line text inside the one cell', async ({ page }) => {
  await vaultOpen(page)
  const note = await openTableNote(page, label('Table Paste Multiline'))

  await placeCursorAtEndOf(page, 'Review')
  await pastePlainText(page, ' first\nsecond')

  const cells = await tableCells(page)
  expect(cells).toHaveLength(3)
  expect(cells?.every((row) => row.length === 2)).toBe(true)
  expect(cells?.[2][0]).toContain('first')
  expect(cells?.[2][0]).toContain('second')

  // A markdown row is one line, so the newline becomes a space on disk.
  await expect.poll(() => savedBody(page, note.id), { timeout: 20_000 }).toContain('second')
  expect(await savedBody(page, note.id)).toMatch(/\|\s*Review first second\s*\|\s*Nobody\s*\|/)
})

test('moves text from one cell into another on cut and paste', async ({ page }) => {
  await vaultOpen(page)
  const note = await openTableNote(page, label('Table Paste Cut'))

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
  await expect.poll(() => savedBody(page, note.id), { timeout: 20_000 }).toContain('KaanNobody')
})
