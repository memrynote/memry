// The open note's BlockNote editor, read and written as Electron's editor specs do through
// `window.__memryActiveEditor` (`renderer/src/commands/editor-target.ts`). Step 14k (#3531).
import { createNote, getNote, NOTE_EDITOR, openFromSidebar, type NoteView } from './notes'
import type { Page } from './pw-compat/page'

/** The part of BlockNote's block the specs read. */
export interface EditorBlock {
  id: string
  type: string
  props?: Record<string, unknown>
  content?: Array<{ text?: string }> | string
  children?: EditorBlock[]
}

/** Creates a note, opens it from the sidebar and waits for its editor. */
export async function openNewNote(page: Page, title: string, content = ''): Promise<NoteView> {
  const note = await createNote(page, { title, content })
  await openFromSidebar(page, note)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
  return note
}

/** The open editor's top-level blocks. */
export const editorDocument = (page: Page): Promise<EditorBlock[]> =>
  page.evaluate(() => {
    const editor = (window as unknown as { __memryActiveEditor?: { document: EditorBlock[] } })
      .__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    return editor.document
  })

/** Replaces the whole document, then puts the caret at the end of block `caret` when given. */
export async function setBlocks(page: Page, blocks: unknown[], caret?: number): Promise<void> {
  await page.evaluate(
    ({ next, at }: { next: unknown[]; at?: number }) => {
      const editor = (
        window as unknown as {
          __memryActiveEditor?: {
            document: Array<{ id: string }>
            replaceBlocks(old: unknown[], next: unknown[]): void
            setTextCursorPosition(id: string, where: 'end'): void
          }
        }
      ).__memryActiveEditor
      if (!editor) throw new Error('window.__memryActiveEditor not exposed')
      editor.replaceBlocks(editor.document, next)
      if (at !== undefined) editor.setTextCursorPosition(editor.document[at].id, 'end')
    },
    { next: blocks, at: caret }
  )
}

export const blockText = (block: EditorBlock): string =>
  Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : ''

/** Paragraphs of plain text, as the specs seed them. */
export const paragraphs = (texts: string[]): unknown[] =>
  texts.map((text) => ({
    type: 'paragraph',
    content: text ? [{ type: 'text', text, styles: {} }] : ''
  }))

/** Each top-level block's text, the trailing empty blocks BlockNote keeps to type into dropped. */
export async function blockTexts(page: Page): Promise<string[]> {
  const texts = (await editorDocument(page)).map(blockText)
  while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop()
  return texts
}

/** The note's body as `notes_get` reads it, line endings and blank runs normalized. */
export async function noteBody(page: Page, id: string): Promise<string | null> {
  const body = (await getNote(page, id))?.content
  if (body === undefined) return null
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/**
 * Types into the focused editor one character at a time. WebDriver's key actions put no text
 * into a contenteditable, and the browser's own `insertText` command does, as `beforeinput`; one
 * character per command keeps a trigger such as `/` its own input, as a keystroke is.
 */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  for (const char of text) await page.keyboard.insertText(char)
}
