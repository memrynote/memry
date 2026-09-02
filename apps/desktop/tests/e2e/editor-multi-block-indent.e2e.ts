import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS, SHORTCUTS } from './utils/electron-helpers'
import { createNoteWithBody } from './utils/note-sync-helpers'

const NESTED_MARKER = 'memry:block-nesting-level=1'
const TAG_MENU = '[role="listbox"]'

interface BlockShape {
  text: string
  children: BlockShape[]
}

async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
}

async function selectBlocks(page: Page, fromIndex: number, toIndex: number): Promise<void> {
  await focusEditor(page)
  await page.evaluate(
    ({ from, to }) => {
      const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
      if (!editor) throw new Error('window.__memryEditor not exposed')
      const doc = editor.document as Array<{ id: string }>
      editor.focus()
      editor.setSelection(doc[from].id, doc[to].id)
    },
    { from: fromIndex, to: toIndex }
  )
}

async function placeCaretAtEnd(page: Page, blockIndex: number): Promise<void> {
  await focusEditor(page)
  await page.evaluate((index) => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const doc = editor.document as Array<{ id: string }>
    editor.focus()
    editor.setTextCursorPosition(doc[index].id, 'end')
  }, blockIndex)
}

async function documentShape(page: Page): Promise<BlockShape[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const text = (content: unknown): string =>
      Array.isArray(content)
        ? content
            .map((item) =>
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
    const walk = (blocks: any[]): BlockShape[] =>
      blocks.map((block) => ({ text: text(block.content), children: walk(block.children ?? []) }))
    const shape = walk(editor.document as any[])
    // BlockNote keeps an empty trailing paragraph after the last real block.
    while (shape.length > 1 && shape.at(-1)?.text === '' && shape.at(-1)?.children.length === 0) {
      shape.pop()
    }
    return shape
  })
}

async function storedContent(page: Page, noteId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const note = await window.api.notes.get(id)
    return note?.content ?? ''
  }, noteId)
}

async function seedTag(page: Page, tag: string): Promise<void> {
  await page.evaluate(
    async ({ title, body }) => {
      const result = await window.api.notes.create({ title, content: body })
      if (!result.success) throw new Error(result.error || 'tag seed note failed')
    },
    { title: uniqueLabel('Tag seed'), body: `Seeded with #${tag}` }
  )
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const tags = await window.api.notes.getTags()
          return tags.map((entry: { tag: string }) => entry.tag)
        }),
      { timeout: 15_000 }
    )
    .toContain(tag)
}

const flat = (...lines: string[]): BlockShape[] => lines.map((text) => ({ text, children: [] }))

test.describe('Multi-block Tab indent', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('Tab indents every selected block and Shift+Tab brings them all back', async ({ page }) => {
    const note = await createNoteWithBody(
      page,
      uniqueLabel('Multi indent'),
      'Anchor\nFirst\nSecond'
    )
    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))

    await selectBlocks(page, 1, 2)
    await page.keyboard.press('Tab')

    await expect
      .poll(() => documentShape(page))
      .toEqual([{ text: 'Anchor', children: flat('First', 'Second') }])
    await expect
      .poll(() => storedContent(page, note.id), { timeout: 10_000 })
      .toContain(NESTED_MARKER)

    await page.keyboard.press('Shift+Tab')

    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))
    await expect
      .poll(() => storedContent(page, note.id), { timeout: 10_000 })
      .not.toContain(NESTED_MARKER)
  })

  test('one undo reverts the whole multi-block indent', async ({ page }) => {
    await createNoteWithBody(page, uniqueLabel('Multi indent undo'), 'Anchor\nFirst\nSecond')
    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))

    await selectBlocks(page, 1, 2)
    await page.keyboard.press('Tab')
    await expect
      .poll(() => documentShape(page))
      .toEqual([{ text: 'Anchor', children: flat('First', 'Second') }])

    // Past y-prosemirror's capture window, so the undo below cannot merge with
    // anything that follows it.
    await page.waitForTimeout(700)
    await page.keyboard.press(SHORTCUTS.undo)
    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'First', 'Second'))
  })

  test('a block that cannot nest is skipped and the rest still indent', async ({ page }) => {
    await createNoteWithBody(page, uniqueLabel('Multi indent skip'), 'First\nSecond')
    await expect.poll(() => documentShape(page)).toEqual(flat('First', 'Second'))

    await selectBlocks(page, 0, 1)
    await page.keyboard.press('Tab')

    await expect
      .poll(() => documentShape(page))
      .toEqual([{ text: 'First', children: flat('Second') }])
  })

  test('Tab completes the open tag suggestion instead of indenting', async ({ page }) => {
    // Typed two characters short below, so the menu has exactly one match.
    const tag = `mbi${Math.random().toString(36).slice(2, 8)}`
    await seedTag(page, tag)

    await createNoteWithBody(page, uniqueLabel('Tag menu Tab'), 'Anchor\nSecond')
    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', 'Second'))

    await placeCaretAtEnd(page, 1)
    await page.keyboard.type(` #${tag.slice(0, -2)}`)
    await expect(page.locator(TAG_MENU)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(TAG_MENU)).toContainText(tag)

    await page.keyboard.press('Tab')

    await expect(page.locator(`.inline-hash-tag[data-hash-tag="${tag}"]`)).toBeVisible()
    await expect(page.locator(TAG_MENU)).toBeHidden()
    await expect.poll(() => documentShape(page)).toEqual(flat('Anchor', `Second #${tag}`))
  })
})
