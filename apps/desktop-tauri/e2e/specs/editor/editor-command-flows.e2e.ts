// Slash commands, the formatting toolbar, file drops and URL paste choices, ported from Electron's
// `editor-command-flows.e2e.ts` (Step 14z, #3531). The drop and the paste are real `DragEvent`s
// and `ClipboardEvent`s carrying a real `DataTransfer`, against the real editor; the uploads are
// read back through `notes_list_attachments`.
import { PNG_BYTES } from '../../harness/attachments'
import {
  editorDocument,
  expectSuggestionMenuOpen,
  openNewNote,
  setBlocks,
  paragraphs,
  typeInEditor,
  type EditorBlock
} from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

interface InlineContent {
  type: string
  text?: string
  href?: string
  styles?: Record<string, unknown>
}

const inlineOf = (block: EditorBlock | undefined): InlineContent[] =>
  Array.isArray(block?.content) ? (block.content as InlineContent[]) : []

async function openFreshNote(page: Page, name: string) {
  await vaultOpen(page)
  const note = await openNewNote(page, label(name))
  await page.locator(NOTE_EDITOR).first().click()
  return note
}

/** Pastes plain text into the editor as the browser hands a paste to ProseMirror. */
const pastePlainText = (page: Page, text: string): Promise<void> =>
  page.evaluate(
    ([selector, value]: [string, string]) => {
      const editable = document.querySelector(selector)
      if (!editable) throw new Error('contenteditable editor not found')
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', value)
      editable.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      )
    },
    [NOTE_EDITOR, text]
  )

test('inserts slash command blocks and applies formatting toolbar marks', async ({ page }) => {
  await openFreshNote(page, 'Slash Commands')

  await typeInEditor(page, '/callout')
  await expectSuggestionMenuOpen(page, 'Callout')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await editorDocument(page)).map((block) => block.type))
    .toContain('callout')

  await setBlocks(page, paragraphs(['Bold from toolbar']), 0)
  // Triple-click selects the paragraph's text. Cmd/Ctrl+A selects every block instead, which
  // shows no formatting toolbar.
  await page.locator(NOTE_EDITOR).first().getByText('Bold from toolbar').click({ clickCount: 3 })
  await page.getByRole('button', { name: 'Bold' }).first().click()
  await expect
    .poll(async () =>
      inlineOf((await editorDocument(page))[0]).some((part) => Boolean(part.styles?.bold))
    )
    .toBe(true)
})

test('uploads dropped files and embeds pasted YouTube links into editor blocks', async ({
  page
}) => {
  const note = await openFreshNote(page, 'Editor Drop')

  await page.evaluate((pngBytes: number[]) => {
    const container = document.querySelector('.bn-container')
    if (!container) throw new Error('BlockNote container not found')
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(
      new File([new Uint8Array(pngBytes)], 'drop-image.png', { type: 'image/png' })
    )
    dataTransfer.items.add(new File(['drop text'], 'drop-note.txt', { type: 'text/plain' }))
    for (const type of ['dragenter', 'dragover', 'drop']) {
      container.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })
      )
    }
  }, Array.from(PNG_BYTES))

  await expect
    .poll(
      async () => {
        const types = new Set((await editorDocument(page)).map((block) => block.type))
        return types.has('image') && types.has('file')
      },
      { timeout: 20_000 }
    )
    .toBe(true)

  const attachmentNames = (
    await invoke<Array<{ filename: string }>>(page, 'notes_list_attachments', {
      noteId: note.id
    })
  ).map((attachment) => attachment.filename)
  expect(attachmentNames.some((name) => name.endsWith('drop-image.png'))).toBe(true)
  expect(attachmentNames.some((name) => name.endsWith('drop-note.txt'))).toBe(true)

  await setBlocks(page, paragraphs(['']), 0)
  await pastePlainText(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  await expect(page.locator('[data-inline-choice-menu]')).toBeVisible()
  // Menu order: Mention, Embed, Bookmark, URL; one ArrowDown reaches Embed.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      (await editorDocument(page))
        .filter((block) => block.type === 'youtubeEmbed')
        .map((block) => block.props?.videoId)
    )
    .toContain('dQw4w9WgXcQ')
})

// Inline AI still reaches its server through the not-ported `window.electron.ipcRenderer`
// channels (`hooks/use-ai-inline.ts`); Step 22 (#3539) replaces them with `ai_inline_*` commands
// and ports this case with them.
test.skip('opens AI inline commands, invokes a selection command, and cancels the menu', () => {})

// Issue #2081: choosing "URL" used to replace the list item with a paragraph, so the bullet
// disappeared. Issue #2080: the pasted URL has to stay ordinary editable inline content.
test('keeps the bullet and an editable link when a URL is pasted into a list item', async ({
  page
}) => {
  const url = 'https://example.com/paste-target'
  await openFreshNote(page, 'Paste URL In List')
  await setBlocks(page, [{ type: 'bulletListItem', content: '' }], 0)

  await pastePlainText(page, url)
  await expect(page.locator('[data-inline-choice-menu]')).toBeVisible()
  // Menu order: Mention, Bookmark, URL; "URL" is always the last option.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')

  const firstBlock = async () => (await editorDocument(page))[0]
  await expect
    .poll(async () => {
      const block = await firstBlock()
      return {
        type: block?.type,
        links: inlineOf(block)
          .filter((inline) => inline.type === 'link')
          .map((inline) => inline.href)
      }
    })
    .toEqual({ type: 'bulletListItem', links: [url] })

  // The bullet is still rendered, not just present in the model.
  await expect(
    page.locator('.bn-block-content[data-content-type="bulletListItem"]').first()
  ).toBeVisible()

  // The link is editable inline content: typing continues the same list item instead of
  // replacing or deleting the link.
  await typeInEditor(page, ' tail')
  await expect
    .poll(async () => {
      const block = await firstBlock()
      return {
        type: block?.type,
        text: inlineOf(block)
          .map((inline) => (inline.type === 'link' ? '<link>' : (inline.text ?? '')))
          .join('')
      }
    })
    .toEqual({ type: 'bulletListItem', text: '<link> tail' })
})
