// Tab and Shift+Tab over a selection of several blocks, ported from Electron's
// `editor-multi-block-indent.e2e.ts` (Step 14k, #3531).
import { SHORTCUTS } from '../../harness/app-helpers'
import { noteBody, openNoteWithLines, typeInEditor } from '../../harness/editor'
import { createNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { listedTags } from '../../harness/tags'
import { test, expect } from '../../harness/test'

const NESTED_MARKER = 'memry:block-nesting-level=1'
const TAG_MENU = '[role="listbox"]'

interface BlockShape {
  text: string
  children: BlockShape[]
}

const label = (name: string): string => `${name} ${Date.now().toString(36)}`
const flat = (...lines: string[]): BlockShape[] => lines.map((text) => ({ text, children: [] }))

/** Focuses the editor, then selects blocks `from` to `to`, or puts the caret at the end of `from`. */
async function select(page: Page, from: number, to?: number): Promise<void> {
  await page.locator(NOTE_EDITOR).first().click()
  await page.evaluate(
    ({ a, b }: { a: number; b?: number }) => {
      // oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's editor has no type in the e2e tsconfig
      const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
      if (!editor) throw new Error('window.__memryActiveEditor not exposed')
      const doc = editor.document as Array<{ id: string }>
      editor.focus()
      if (b === undefined) editor.setTextCursorPosition(doc[a].id, 'end')
      else editor.setSelection(doc[a].id, doc[b].id)
    },
    { a: from, b: to }
  )
}

/**
 * Shift+Tab as the WebDriver plugin sends Tab, a synthetic keydown on the focused element, with
 * `shiftKey` set. tauri-plugin-wdio-webdriver 1.5.0 (`dispatch_key_event`) drops held modifiers
 * on named keys such as Tab, so `press('Shift+Tab')` reaches the page as a bare Tab.
 */
const shiftTab = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const init = { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true }
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { ...init, bubbles: true, cancelable: true }))
  })

/** Each block's text and children, an inline tag read as `#tag`, the trailing empty block dropped. */
const documentShape = (page: Page): Promise<BlockShape[]> =>
  page.evaluate(() => {
    // oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's block shape is open-ended
    type Node = any
    const editor = (window as unknown as { __memryActiveEditor?: { document: Node[] } })
      .__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const text = (content: unknown): string =>
      Array.isArray(content)
        ? content
            .map((item: Node) =>
              typeof item?.text === 'string'
                ? item.text
                : typeof item?.attrs?.tag === 'string'
                  ? `#${item.attrs.tag}`
                  : typeof item?.props?.tag === 'string'
                    ? `#${item.props.tag}`
                    : ''
            )
            .join('')
        : ''
    const walk = (blocks: Node[]): BlockShape[] =>
      blocks.map((block) => ({ text: text(block.content), children: walk(block.children ?? []) }))
    const shape = walk(editor.document)
    while (shape.length > 1 && shape.at(-1)?.text === '' && shape.at(-1)?.children.length === 0) {
      shape.pop()
    }
    return shape
  })

test('Tab indents every selected block and Shift+Tab brings them all back', async ({ page }) => {
  await vaultOpen(page)
  const note = await openNoteWithLines(page, label('Multi indent'), ['Anchor', 'First', 'Second'])
  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))

  await select(page, 1, 2)
  await page.keyboard.press('Tab')

  await expect
    .poll(() => documentShape(page))
    .toEqual([{ text: 'Anchor', children: flat('First', 'Second') }])
  await expect.poll(() => noteBody(page, note.id)).toContain(NESTED_MARKER)

  await shiftTab(page)

  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))
  await expect.poll(() => noteBody(page, note.id)).not.toContain(NESTED_MARKER)
})

test('one undo reverts the whole multi-block indent', async ({ page }) => {
  await vaultOpen(page)
  await openNoteWithLines(page, label('Multi indent undo'), ['Anchor', 'First', 'Second'])
  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))

  await select(page, 1, 2)
  await page.keyboard.press('Tab')
  await expect
    .poll(() => documentShape(page))
    .toEqual([{ text: 'Anchor', children: flat('First', 'Second') }])

  // Past y-prosemirror's capture window, so the undo cannot merge with what follows it.
  await page.waitForTimeout(700)
  await page.keyboard.press(SHORTCUTS.undo)
  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))
})

test('a block that cannot nest is skipped and the rest still indent', async ({ page }) => {
  await vaultOpen(page)
  await openNoteWithLines(page, label('Multi indent skip'), ['First', 'Second'])
  await expect.poll(() => documentShape(page)).toEqual(flat('First', 'Second'))

  await select(page, 0, 1)
  await page.keyboard.press('Tab')

  await expect
    .poll(() => documentShape(page))
    .toEqual([{ text: 'First', children: flat('Second') }])
})

// Skipped until #4182: the tag suggestion list never mounts in Tauri (`getAISettings` is not
// ported, so `aiEnabled` is false).
test.skip('Tab completes the open tag suggestion instead of indenting', async ({ page }) => {
  await vaultOpen(page)
  // Typed two characters short below, so the menu has exactly one match.
  const tag = `mbi${Math.random().toString(36).slice(2, 8)}`
  await createNote(page, { title: label('Tag seed'), content: `Seeded with #${tag}` })
  await expect.poll(async () => (await listedTags(page)).map((entry) => entry.name)).toContain(tag)

  await openNoteWithLines(page, label('Tag menu Tab'), ['Anchor', 'Second'])
  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'Second'))

  await select(page, 1)
  await typeInEditor(page, ` #${tag.slice(0, -2)}`)
  await expect(page.locator(TAG_MENU)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(TAG_MENU)).toContainText(tag)

  await page.keyboard.press('Tab')

  await expect(page.locator(`.inline-hash-tag[data-hash-tag="${tag}"]`)).toBeVisible()
  await expect(page.locator(TAG_MENU)).toBeHidden()
  await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', `Second #${tag}`))
})
