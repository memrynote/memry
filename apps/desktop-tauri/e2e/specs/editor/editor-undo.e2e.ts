// Undo history of the note and journal editors, ported from Electron's `editor-undo.e2e.ts`
// (Step 14k, #3531): undo right after opening keeps the seeded body, undo reverts a local edit,
// and the Edit menu's Undo reverts it too.
import { navigateTo, SHORTCUTS } from '../../harness/app-helpers'
import { noteBody, typeInEditor } from '../../harness/editor'
import { invokeTest } from '../../harness/invoke-test'
import { expectNoteBody, normalizeBodyText } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { sleep } from '../../harness/wait'

const invoke = (page: Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(
    ({ name, params }: { name: string; params: Record<string, unknown> }) =>
      window.__TAURI__.core.invoke(name, params),
    { name: command, params: args }
  )

async function openSeededNote(page: Page, title: string, content: string): Promise<string> {
  await vaultOpen(page)
  const note = await createNote(page, { title, content })
  await openFromSidebar(page, note)
  await expectNoteBody(page, content)
  return note.id
}

const today = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const now = new Date()
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
  })

async function openSeededJournal(page: Page, content: string): Promise<string> {
  await vaultOpen(page)
  const date = await today(page)
  await invoke(page, 'journal_create_entry', { input: { date, content } })
  await navigateTo(page, 'journal')
  await expectNoteBody(page, content)
  return date
}

async function journalContent(page: Page, date: string): Promise<string | null> {
  const entry = (await invoke(page, 'journal_get_entry', { date })) as { content: string } | null
  return entry?.content ?? null
}

/**
 * Puts the caret where a click below the note's last line does: on a new empty paragraph after
 * it (Electron's `focusEditorEnd`, after `focusAtEndRef` in `use-block-note-setup.ts`).
 */
async function focusEditorEnd(page: Page): Promise<void> {
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.evaluate(() => {
    const editor = (
      window as unknown as {
        __memryActiveEditor?: {
          document: Array<{ id: string; type: string; content?: unknown }>
          focus(): void
          insertBlocks(blocks: unknown[], ref: string, where: 'after'): Array<{ id: string }>
          setTextCursorPosition(id: string | { id: string }, where: 'start' | 'end'): void
        }
      }
    ).__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const last = editor.document.at(-1)
    editor.focus()
    if (!last) return
    const empty =
      last.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0
    if (empty) {
      editor.setTextCursorPosition(last.id, 'end')
      return
    }
    const [inserted] = editor.insertBlocks([{ type: 'paragraph' }], last.id, 'after')
    editor.setTextCursorPosition(inserted, 'start')
  })
}

test.describe('Editor undo history', () => {
  test('note first-open undo preserves the seeded body', async ({ page }) => {
    const body = `Undo seed line ${Date.now()}\n\nSecond seeded line`
    const noteId = await openSeededNote(page, `Undo Note ${Date.now()}`, body)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteBody(page, body)

    await sleep(1500)
    await expect.poll(() => noteBody(page, noteId)).toBe(normalizeBodyText(body))
  })

  test('note undo still works after a local edit', async ({ page }) => {
    const body = `Undo editable seed ${Date.now()}`
    const typed = 'typed after open'
    await openSeededNote(page, `Undo Editable Note ${Date.now()}`, body)

    await focusEditorEnd(page)
    await typeInEditor(page, typed)
    await expectNoteBody(page, `${body}\n\n${typed}`)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteBody(page, body)
  })

  test('Edit menu Undo reverts a local edit', async ({ app, page }) => {
    // Drives the menu item, not the keyboard: Electron's Edit > Undo once used the webview's
    // own undo stack, which is empty in the BlockNote editor.
    const body = `Menu undo seed ${Date.now()}`
    const typed = 'typed before menu undo'
    await openSeededJournal(page, body)

    await focusEditorEnd(page)
    await typeInEditor(page, typed)
    await expectNoteBody(page, `${body}\n\n${typed}`)

    await invokeTest(app, 'e2e_menu_activate', { id: 'editor.undo' })
    await expectNoteBody(page, body)
  })

  test('journal first-open undo preserves the seeded entry', async ({ page }) => {
    const body = `Journal undo seed ${Date.now()}\n\nStill here after undo`
    const date = await openSeededJournal(page, body)

    await page.keyboard.press(SHORTCUTS.undo)
    await expectNoteBody(page, body)

    await sleep(1500)
    await expect.poll(() => journalContent(page, date)).toBe(body)
  })
})
