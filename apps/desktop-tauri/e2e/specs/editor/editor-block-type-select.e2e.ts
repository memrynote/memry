// The formatting toolbar's block type select and the block menu's Turn into over a mouse
// selection or a marquee, ported from Electron's `editor-block-type-select.e2e.ts` (Step 14k,
// #3531). Marquees are drawn with the pointer. A text selection is set between the two points a
// drag would cover: the WebDriver plugin's pointer actions are synthetic mouse events, which make
// no native text selection in WKWebView.
import { blockText, editorDocument, glide, openNoteWithLines } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

interface BlockSummary {
  type: string
  level?: number
  text: string
}

const label = (name: string): string => `${name} ${Date.now().toString(36)}`
const LINES = ['Alpha line', 'Beta line', 'Gamma line', 'Last line']

/** Each block's type, heading level and text, the trailing empty block dropped. */
async function blocks(page: Page): Promise<BlockSummary[]> {
  const summary = (await editorDocument(page)).map((block) => ({
    type: block.type,
    ...(block.type === 'heading' ? { level: block.props?.level as number } : {}),
    text: blockText(block)
  }))
  if (summary.at(-1)?.text === '') summary.pop()
  return summary
}
const types = async (page: Page): Promise<string[]> => (await blocks(page)).map((b) => b.type)

const textBox = async (page: Page, text: string) => {
  const box = await page.locator(NOTE_EDITOR).getByText(text, { exact: true }).first().boundingBox()
  if (!box) throw new Error(`no box for ${text}`)
  return box
}

/** Presses at `from`, moves to `to` in `steps` moves and releases. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(page, to, steps)
  await page.mouse.up()
}

/**
 * Clicks the editor at `from`, then selects the text from `from` to `to`, as a drag does.
 *
 * The selection goes through ProseMirror, not the DOM: the click focuses the editor, and
 * ProseMirror's focus handler writes its own (collapsed) selection back to the DOM 20 ms
 * later unless its observer has already seen the DOM change. A raw `setBaseAndExtent`
 * inside that window was undone about 1 run in 10 (#4184).
 */
async function selectBetween(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await page.mouse.click(from.x, from.y)
  await page.evaluate(
    ({ a, b }: Record<'a' | 'b', { x: number; y: number }>) => {
      const start = document.caretRangeFromPoint(a.x, a.y)
      const end = document.caretRangeFromPoint(b.x, b.y)
      if (!start || !end) throw new Error('no caret at a selection end')
      // oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's editor has no type in the e2e tsconfig
      const tiptap = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
        ._tiptapEditor
      tiptap.commands.setTextSelection({
        from: tiptap.view.posAtDOM(start.startContainer, start.startOffset),
        to: tiptap.view.posAtDOM(end.startContainer, end.startOffset)
      })
    },
    { a: from, b: to }
  )
}

/** A marquee from the margin beside block 0 down to the middle of block `last`. */
async function marquee(page: Page, last: number): Promise<void> {
  const zone = await page.locator('.marquee-zone').first().boundingBox()
  const first = await page.locator('.bn-block[data-id]').nth(0).boundingBox()
  const end = await page.locator('.bn-block[data-id]').nth(last).boundingBox()
  if (!zone || !first || !end) throw new Error('no boxes')
  // Well clear of the side menu's handle, which also sits in the margin.
  await drag(
    page,
    { x: zone.x + 12, y: first.y + 2 },
    { x: first.x + first.width / 2, y: end.y + end.height / 2 },
    14
  )
  await expect.poll(() => page.locator('.marquee-block-highlight').count()).toBe(last + 1)
}

async function pickBlockType(page: Page, name: string): Promise<void> {
  const trigger = page.locator('.memry-format-toolbar-block-type-trigger button').first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()
  const option = page.getByRole('option', { name, exact: true })
  await expect(option).toBeVisible({ timeout: 5_000 })
  await option.click()
}

test('retypes the block holding a partial text selection', async ({ page }) => {
  await vaultOpen(page)
  await openNoteWithLines(page, label('Block type partial'), LINES)
  await expect.poll(() => blocks(page)).toHaveLength(4)

  const beta = await textBox(page, 'Beta line')
  const y = beta.y + beta.height / 2
  await selectBetween(
    page,
    { x: beta.x + beta.width * 0.2, y },
    { x: beta.x + beta.width * 0.7, y }
  )
  await pickBlockType(page, 'Heading 5')

  await expect(page.getByRole('option')).toHaveCount(0)
  await expect
    .poll(() => blocks(page))
    .toEqual([
      { type: 'paragraph', text: 'Alpha line' },
      { type: 'heading', level: 5, text: 'Beta line' },
      { type: 'paragraph', text: 'Gamma line' },
      { type: 'paragraph', text: 'Last line' }
    ])
})

test('retypes every block in a multi-line selection', async ({ page }) => {
  await vaultOpen(page)
  await openNoteWithLines(page, label('Block type multi'), LINES)
  await expect.poll(() => blocks(page)).toHaveLength(4)

  const from = await textBox(page, 'Alpha line')
  const to = await textBox(page, 'Beta line')
  await selectBetween(
    page,
    { x: from.x + 4, y: from.y + from.height / 2 },
    { x: to.x + to.width - 4, y: to.y + to.height / 2 }
  )
  await pickBlockType(page, 'Heading 2')

  await expect
    .poll(() => blocks(page))
    .toEqual([
      { type: 'heading', level: 2, text: 'Alpha line' },
      { type: 'heading', level: 2, text: 'Beta line' },
      { type: 'paragraph', text: 'Gamma line' },
      { type: 'paragraph', text: 'Last line' }
    ])
})

test('Turn into from the block menu converts every marquee-selected text block', async ({
  page
}) => {
  await vaultOpen(page)
  await openNoteWithLines(page, label('Turn into marquee'), [
    'Alpha line',
    'Beta line',
    'Last line'
  ])
  await expect.poll(() => blocks(page)).toHaveLength(3)
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's editor has no type in the e2e tsconfig
    const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
    editor.insertBlocks(
      [{ type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a', 'b'] }] } }],
      editor.document[1].id,
      'after'
    )
  })
  await expect.poll(() => types(page)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph'])

  await marquee(page, 2)

  await page.locator('.bn-block-content').nth(1).hover()
  const handle = page.locator('[data-test="dragHandle"]').first()
  await handle.waitFor({ state: 'visible', timeout: 5_000 })
  await handle.click()
  await expect.poll(() => page.locator('.marquee-block-highlight').count()).toBe(3)
  await page.getByRole('menuitem', { name: 'Turn into' }).hover()
  await page.getByRole('menuitem', { name: 'Heading 2' }).click()

  await expect.poll(() => types(page)).toEqual(['heading', 'heading', 'table', 'paragraph'])
})

test('sticky toolbar retypes marquee-selected blocks, not the last line', async ({ page }) => {
  await vaultOpen(page)
  await page.evaluate(() => window.api.settings.setEditorSettings({ toolbarMode: 'sticky' }))
  await openNoteWithLines(page, label('Marquee toolbar'), ['One', 'Two', 'Three', 'Last line'])
  await expect.poll(() => blocks(page)).toHaveLength(4)
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's editor has no type in the e2e tsconfig
    const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
    for (const block of (editor.document as Array<{ id: string }>).slice(0, 3)) {
      editor.updateBlock(block.id, { type: 'bulletListItem' })
    }
  })
  await expect
    .poll(() => types(page))
    .toEqual(['bulletListItem', 'bulletListItem', 'bulletListItem', 'paragraph'])

  await marquee(page, 2)
  await page.locator('[data-test="list-type-numbered"]').first().click()

  await expect
    .poll(() => types(page))
    .toEqual(['numberedListItem', 'numberedListItem', 'numberedListItem', 'paragraph'])
})
