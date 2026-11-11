// A table cell's colour and marks survive a save and a reopen (#1639), ported from Electron's
// `table-cell-colors.e2e.ts` (Step 14k, #3531). A GFM row has nowhere to keep a colour, so the
// save writes a `<!-- table-colors:… -->` marker in front of the table, and the cell menu that
// sets it is the cell's inline-end nub (`table-border-handles.tsx`).
import { noteBody, openNewNote, setBlocks } from '../../harness/editor'
import { NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { tableBlock, tableShape } from '../../harness/table'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const TABLE_DOC = [
  tableBlock([
    ['Task', 'State'],
    ['Shipping', 'Open']
  ])
]
const TABLE_MD = ['| Task | State |', '| --- | --- |', '| Shipping | Open |'].join('\n')

/**
 * Where to aim inside a cell: a fixed 120 px cell leaves a short word's middle empty, and the
 * block drag handle overhangs the first column's corner.
 */
const IN_CELL = { x: 20, y: 20 }

async function shape(page: Page) {
  const value = await tableShape(page)
  if (!value) throw new Error('no table in the document')
  return value
}

/**
 * Selects the word the cell holds, as a double-click does. The driver's pointer events are
 * synthetic and select no word in WKWebView, so the DOM selection is set over the cell's text, and
 * ProseMirror takes it from `selectionchange`. Polled until the editor's own selection is the
 * word: a mark applied to a caret changes nothing in the file.
 */
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

test('a cell coloured from the cell menu is still coloured after a reopen', async ({ page }) => {
  await vaultOpen(page)
  const note = await openNewNote(page, `Table Cell Colour ${Date.now()}`, 'seed')
  await setBlocks(page, TABLE_DOC)

  // With both colour flags off `TableCellMenu` renders nothing, so a Colors item is itself the
  // proof that they are on.
  const bodyCell = page.locator(`${NOTE_EDITOR} td`).first()
  const box = await bodyCell.boundingBox()
  if (!box) throw new Error('body cell has no box')
  await page.mouse.move(box.x + IN_CELL.x, box.y + IN_CELL.y)
  const cellHandle = page.locator('[data-memry-table-handle="cell"]').first()
  await expect(cellHandle).toBeVisible({ timeout: 10_000 })
  await cellHandle.click()
  await page.getByText('Colors', { exact: true }).first().click()
  await page.locator('[data-test="background-color-red"]').first().click()

  await expect
    .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 20_000 })
    .toContain('<!-- table-colors:')
  const saved = await noteBody(page, note.id)
  expect(saved).toContain('"1:0":{"backgroundColor":"red"}')
  expect(saved).toContain('| Shipping')

  await reopen(page, note)
  await expect.poll(async () => (await shape(page))[1][0].backgroundColor).toBe('red')
  expect((await shape(page))[0][0].backgroundColor).not.toBe('red')
  // The reopen rewrote nothing: the round trip converged on the first save.
  expect(await noteBody(page, note.id)).toBe(saved)
})

test('a table whose marker was written by hand opens coloured and is not rewritten', async ({
  page
}) => {
  // Bytes the editor never produced, as another editor would have left them.
  await vaultOpen(page)
  const body = `<!-- table-colors:{"1:1":{"textColor":"blue"}} -->\n${TABLE_MD}`
  const note = await openNewNote(page, `Table Colour Marker ${Date.now()}`, body)

  await expect.poll(async () => (await shape(page))[1][1].textColor).toBe('blue')
  const cells = await shape(page)
  expect(cells[1][0].textColor).not.toBe('blue')
  // The marker line is not sitting in the note as a paragraph.
  expect(cells[1][1].text).toBe('Open')
  expect(await noteBody(page, note.id)).toBe(body)
})

const PROBE_INSTALL = () => {
  const w = window as unknown as Record<string, any>
  const log: unknown[] = []
  const t0 = performance.now()
  const at = () => Math.round(performance.now() - t0)
  const desc = (n: unknown) => {
    const e = n as HTMLElement | null
    if (!e || !e.tagName) return String(n)
    return `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`
  }
  w.__probe = { log, at }
  const ed = w.__memryActiveEditor
  w.__probeEditor = ed
  for (const type of ['focusin', 'focusout']) {
    window.addEventListener(type, (e) => log.push([at(), type, desc(e.target)]), true)
  }
  window.addEventListener('blur', () => log.push([at(), 'win-blur']), true)
  window.addEventListener('focus', () => log.push([at(), 'win-focus']), true)
  window.addEventListener(
    'keydown',
    (e) =>
      log.push([at(), 'kd-cap', e.key, e.ctrlKey, e.metaKey, desc(e.target), document.hasFocus()]),
    true
  )
  window.addEventListener('keydown', (e) => log.push([at(), 'kd-bub', e.key, e.defaultPrevented]))
  const tip = ed?._tiptapEditor
  tip?.on('transaction', ({ transaction }: any) =>
    log.push([
      at(),
      'tr',
      transaction.docChanged,
      transaction.selection.from,
      transaction.selection.to,
      Object.keys(transaction.meta ?? {}).join(',')
    ])
  )
  return Boolean(tip)
}

const PROBE_STATE = () => {
  const w = window as unknown as Record<string, any>
  const ed = w.__memryActiveEditor
  const view = ed?._tiptapEditor?.view
  const sel = view?.state.selection
  return {
    t: w.__probe?.at(),
    sameEditor: ed === w.__probeEditor,
    active: `${document.activeElement?.tagName}.${String(document.activeElement?.className).slice(0, 40)}`,
    docFocus: document.hasFocus(),
    viewFocus: view?.hasFocus(),
    sel: sel ? [sel.from, sel.to, sel.constructor.name] : null,
    text: ed?.getSelectedText(),
    domSel: String(window.getSelection()),
    sticky: Boolean(document.querySelector('.sticky-toolbar-enabled')),
    editors: document.querySelectorAll('.ProseMirror').length
  }
}

for (let round = 0; round < 8; round++) {
  test(`PROBE #3967 italic in a cell after a reopen in sticky mode, round ${round}`, async ({
    page
  }) => {
    await vaultOpen(page)
    await invoke(page, 'settings_set_group', {
      group: 'editor',
      patch: { toolbarMode: 'floating' }
    })
    const note = await openNewNote(page, `Table Cell Marks ${round} ${Date.now()}`, 'seed')
    await setBlocks(page, TABLE_DOC)
    await selectWordInCell(page, page.locator(`${NOTE_EDITOR} td`).first(), 'Shipping')
    const bold = page.locator('[data-test="bold"]').first()
    await expect(bold).toBeVisible({ timeout: 10_000 })
    await bold.click()
    await expect
      .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('**Shipping**')

    await invoke(page, 'settings_set_group', { group: 'editor', patch: { toolbarMode: 'sticky' } })
    await reopen(page, note)
    const installed = await page.evaluate(PROBE_INSTALL)
    await selectWordInCell(page, page.locator(`${NOTE_EDITOR} td`).nth(1), 'Open')
    const before = await page.evaluate(PROBE_STATE)
    await page.keyboard.press('ControlOrMeta+i')
    const after = await page.evaluate(PROBE_STATE)
    let ok = true
    try {
      await expect
        .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 10_000 })
        .toContain('*Open*')
    } catch {
      ok = false
    }
    const later = await page.evaluate(PROBE_STATE)
    const log = await page.evaluate(() => (window as any).__probe?.log)
    console.log(
      `PROBE round=${round} ok=${ok} installed=${installed} ${JSON.stringify({ before, after, later, log, body: await noteBody(page, note.id) })}`
    )
    expect(ok).toBe(true)
  })
}
