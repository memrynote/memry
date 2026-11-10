// Toggles stay toggles after a reopen (#1643), ported from Electron's `toggle-blocks.e2e.ts`
// (Step 14k, #3531). BlockNote's HTML export writes a `toggleListItem` as a plain `<li>`, so
// without Memry's `<details data-memry-toggle>` form the note came back as a bullet with its
// nested blocks flattened beside it.
import {
  blockText,
  editorDocument,
  noteBody,
  openNewNote,
  setBlocks,
  typeInEditor
} from '../../harness/editor'
import type { EditorBlock } from '../../harness/editor'
import { NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const IMAGE_URL = 'https://example.com/diagram.png'
const text = (value: string) => [{ type: 'text', text: value, styles: {} }]

/** A toggle holding text, an image, and another toggle: the reported use. */
const TOGGLE_DOC = [
  { type: 'paragraph', content: text('Above') },
  {
    type: 'toggleListItem',
    content: text('Research notes'),
    children: [
      { type: 'paragraph', content: text('Hidden detail') },
      { type: 'image', props: { url: IMAGE_URL } },
      {
        type: 'toggleListItem',
        content: text('Deeper'),
        children: [{ type: 'paragraph', content: text('Deepest') }]
      }
    ]
  }
]

interface Shape {
  type: string
  text: string
  children: Shape[]
}

const shape = (blocks: EditorBlock[]): Shape[] =>
  blocks.map((block) => ({
    type: block.type,
    text: Array.isArray(block.content)
      ? blockText(block)
      : ((block.props?.url as string | undefined) ?? ''),
    children: shape(block.children ?? [])
  }))

/** The document's shape without the empty paragraph BlockNote keeps at the end to type into. */
async function documentShape(page: Page): Promise<Shape[]> {
  const blocks = shape(await editorDocument(page))
  const last = blocks.at(-1)
  return last?.type === 'paragraph' && last.text === '' && last.children.length === 0
    ? blocks.slice(0, -1)
    : blocks
}

test('a toggle keeps its fold and everything nested in it across a reopen', async ({ page }) => {
  await vaultOpen(page)
  const note = await openNewNote(page, `Toggle Persistence ${Date.now()}`)
  await setBlocks(page, TOGGLE_DOC)

  await expect
    .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 20_000 })
    .toContain('<details data-memry-toggle>')
  const saved = await noteBody(page, note.id)
  expect(saved).toContain('<summary>Research notes</summary>')
  expect(saved).toContain('<summary>Deeper</summary>')
  expect(saved).toContain(IMAGE_URL)
  expect(saved).not.toMatch(/^- Research notes$/m)

  await page.reload()
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await expect(page.locator(NOTE_EDITOR).first()).toContainText('Research notes')

  expect(await documentShape(page)).toEqual([
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
  // Reopening rewrote nothing: the round trip converged on the first save.
  expect(await noteBody(page, note.id)).toBe(saved)
})

test('a toggle inserted from the slash menu survives its first save', async ({ page }) => {
  await vaultOpen(page)
  const note = await openNewNote(page, `Toggle Slash Menu ${Date.now()}`)
  await page.locator(NOTE_EDITOR).first().click()

  await typeInEditor(page, '/toggle')
  await expect(page.getByText('Toggle List').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await typeInEditor(page, 'Collapsed heading')

  await expect.poll(async () => (await documentShape(page))[0]?.type).toBe('toggleListItem')
  await expect
    .poll(async () => (await noteBody(page, note.id)) ?? '', { timeout: 20_000 })
    .toContain('<summary>Collapsed heading</summary>')
})
