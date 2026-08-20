// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Toggles have to still be toggles after the note is closed and reopened (#1643).
 *
 * The reported symptom is not that `/toggle` is missing — it inserts fine. It is
 * that the block has no markdown form of its own: BlockNote's HTML export writes
 * a `toggleListItem` as a plain `<li>`, so the note came back as a bullet with
 * everything that was nested under it flattened out beside it.
 *
 * These run on the single-app fixture, which is the NON-collaborative save path
 * (`markdown-utils.ts`) — the one an offline or signed-out user is on. Its twin,
 * the CRDT/sync path (`blocknote-converter.ts`), is pinned by unit tests that
 * drive a real ServerBlockNoteEditor through markdown → Y.Doc → markdown,
 * including the six-pass byte-stability check.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { getNoteFileBodyById, openNoteByHandle, openNoteByTitle } from './utils/note-sync-helpers'

const IMAGE_URL = 'https://example.com/diagram.png'

/** A toggle holding text, an image, and another toggle — the reported use. */
const TOGGLE_DOC = [
  {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Above', styles: {} }]
  },
  {
    type: 'toggleListItem',
    content: [{ type: 'text', text: 'Research notes', styles: {} }],
    children: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hidden detail', styles: {} }] },
      { type: 'image', props: { url: IMAGE_URL } },
      {
        type: 'toggleListItem',
        content: [{ type: 'text', text: 'Deeper', styles: {} }],
        children: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deepest', styles: {} }] }]
      }
    ]
  }
]

async function createNote(page: Page, title: string) {
  return page.evaluate(async (noteTitle) => {
    const result = await window.api.notes.create({ title: noteTitle, content: '' })
    if (!result.success || !result.note) throw new Error(result.error || 'note create failed')
    return { id: result.note.id, title: result.note.title, emoji: result.note.emoji ?? null }
  }, title)
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

/** The document as {type, text, children}, so assertions read like the note. */
async function documentShape(page: Page): Promise<unknown[]> {
  await waitForEditor(page)
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const shape = (blocks: any[]): unknown[] =>
      blocks.map((block) => ({
        type: block.type,
        text: Array.isArray(block.content)
          ? block.content.map((part: any) => part.text ?? '').join('')
          : (block.props?.url ?? ''),
        children: shape(block.children ?? [])
      }))
    return shape(editor.document)
  })
}

/**
 * BlockNote keeps one empty paragraph at the end of every document so there is
 * always somewhere to type. It is editor furniture, not note content — it is
 * never written to the file — so the shape assertions drop it.
 */
function withoutTrailingEmptyParagraph(blocks: any[]): any[] {
  const last = blocks[blocks.length - 1]
  return last?.type === 'paragraph' && last.text === '' && last.children.length === 0
    ? blocks.slice(0, -1)
    : blocks
}

test.describe('Toggle blocks E2E (#1643)', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a toggle keeps its fold and everything nested in it across a reopen', async ({ page }) => {
    // #given a note whose toggle holds text, an image, and a nested toggle
    const title = `Toggle Persistence ${Date.now()}`
    const note = await createNote(page, title)
    await openNoteByHandle(page, note)
    await setDocument(page, TOGGLE_DOC)

    // #when it is saved…
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('<details data-memry-toggle>')
    const saved = await getNoteFileBodyById(page, note.id)
    // …the toggle is a real collapsible on disk, not a bullet
    expect(saved).toContain('<summary>Research notes</summary>')
    expect(saved).toContain('<summary>Deeper</summary>')
    expect(saved).toContain(IMAGE_URL)
    expect(saved).not.toMatch(/^- Research notes$/m)

    // …and the app is restarted and the note opened cold
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await ready(page)
    await openNoteByTitle(page, title)

    // #then the fold and every nested block are still there
    expect(withoutTrailingEmptyParagraph(await documentShape(page))).toEqual([
      { type: 'paragraph', text: 'Above', children: [] },
      {
        type: 'toggleListItem',
        text: 'Research notes',
        children: [
          { type: 'paragraph', text: 'Hidden detail', children: [] },
          { type: 'image', text: IMAGE_URL, children: [] },
          {
            type: 'toggleListItem',
            text: 'Deeper',
            children: [{ type: 'paragraph', text: 'Deepest', children: [] }]
          }
        ]
      }
    ])

    // #and reopening rewrote nothing: the round-trip converged on the first save
    expect(await getNoteFileBodyById(page, note.id)).toBe(saved)
  })

  test('a toggle inserted from the slash menu survives its first save', async ({ page }) => {
    // #given a note and the `/toggle` command the user reached for
    const title = `Toggle Slash Menu ${Date.now()}`
    const note = await createNote(page, title)
    await openNoteByHandle(page, note)
    const editor = await waitForEditor(page)
    await editor.click()

    // #when
    await page.keyboard.type('/toggle')
    await expect(page.getByText('Toggle List').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.type('Collapsed heading')

    // #then it is a toggle in the editor…
    await expect.poll(async () => (await documentShape(page))[0]?.type).toBe('toggleListItem')

    // …and it is still a toggle once written to the note
    await expect
      .poll(async () => (await getNoteFileBodyById(page, note.id)) ?? '', { timeout: 20_000 })
      .toContain('<summary>Collapsed heading</summary>')
  })
})
