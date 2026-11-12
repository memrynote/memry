// What the write-back writes for a list and for paragraphs typed into the editor, ported from the
// two cases of Electron's `vault-markdown-fidelity.e2e.ts` (Step 14z, #3531); Step 12's
// `specs/vault/vault-markdown-fidelity.e2e.ts` covers the same output for edits made without the
// editor. A tight bullet list is written with `-` markers and no blank lines between items, not as
// a loose `*` list. Enter makes a new block, so typed lines are written as separate paragraphs,
// not joined by a soft break or a trailing-backslash hard break. A re-save of the unchanged
// document leaves the body byte for byte. The file bytes below the frontmatter are the assertion,
// as in Electron. A new note's file is empty, and an edited body keeps the file's final-newline
// presence (`serializeParsedMarkdownNote`), so the body ends without a newline, as Electron's does.
import { openNewNote, typeInEditor } from '../../harness/editor'
import { invokeTest } from '../../harness/invoke-test'
import type { WritebackDebugState } from '../../harness/note-sync-helpers'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { vaultBody } from '../../harness/table'
import type { TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

const writebackDebug = (app: TauriApp, noteId: string) =>
  invokeTest<WritebackDebugState | null>(app, 'e2e_writeback_debug_state', { noteId })

/** Types each line, pressing Enter between them, as a user does. */
async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press('Enter')
    await typeInEditor(page, line)
  }
}

/**
 * Waits until a write-back pass after the `performed`th one ran, none is due and `written` holds:
 * a pass that ran while typing was still arriving settles the count but not the file.
 */
async function waitForPassAfter(
  app: TauriApp,
  noteId: string,
  performed: number,
  written: () => boolean
): Promise<void> {
  await expect
    .poll(
      async () => {
        const debug = await writebackDebug(app, noteId)
        return (debug?.performedCount ?? 0) > performed && debug?.pending === false && written()
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  expect((await writebackDebug(app, noteId))?.lastError).toBeNull()
}

/**
 * Opens a new empty note, types `lines` into it and waits for the write-back to put the last
 * line in the file. Returns the note's id and vault-relative path.
 */
async function typedNote(
  app: TauriApp,
  page: Page,
  vaultPath: string,
  title: string,
  lines: string[]
): Promise<{ id: string; path: string }> {
  await vaultOpen(page)
  const note = await openNewNote(page, title)
  await page.locator(NOTE_EDITOR).first().click()
  const performed = (await writebackDebug(app, note.id))?.performedCount ?? 0
  await typeLines(page, lines)
  const last = lines[lines.length - 1]
  await waitForPassAfter(app, note.id, performed, () =>
    vaultBody(vaultPath, note.path).includes(last)
  )
  return { id: note.id, path: note.path }
}

/**
 * Types a character and deletes it at the caret, so the unchanged document is serialized again,
 * then waits for the pass that took the `x` back out of the file. Electron's spec waited a fixed
 * 2.5 s; the debug state says when the pass ran. The bodies under test hold no `x`.
 */
async function resave(
  app: TauriApp,
  page: Page,
  noteId: string,
  read: () => string
): Promise<void> {
  const performed = (await writebackDebug(app, noteId))?.performedCount ?? 0
  await typeInEditor(page, 'x')
  // A WebDriver Backspace key action edits no contenteditable in WKWebView, as with typing; the
  // browser's own delete command reaches the editor as the `beforeinput` a Backspace makes.
  await page.evaluate(() => document.execCommand('delete'))
  await waitForPassAfter(app, noteId, performed, () => !read().includes('x'))
}

test.describe('Vault markdown fidelity in the editor', () => {
  test('a typed bullet list is written as a tight `-` list, stable across a re-save', async ({
    app,
    page,
    testVaultPath
  }) => {
    // `- ` fires BlockNote's list input rule; Enter makes each next line a new list item.
    const note = await typedNote(app, page, testVaultPath, `List Fidelity ${Date.now()}`, [
      '- kaan',
      'sevde',
      'karaca'
    ])
    const read = () => vaultBody(testVaultPath, note.path)

    const body = '- kaan\n- sevde\n- karaca'
    expect(read()).toBe(body)
    await resave(app, page, note.id, read)
    expect(read()).toBe(body)
  })

  test('Enter makes separate paragraphs with no soft or hard breaks, stable across a re-save', async ({
    app,
    page,
    testVaultPath
  }) => {
    const note = await typedNote(app, page, testVaultPath, `Paragraph Fidelity ${Date.now()}`, [
      'line1',
      'line2',
      'line3'
    ])
    const read = () => vaultBody(testVaultPath, note.path)

    const body = 'line1\n\nline2\n\nline3'
    expect(read()).toBe(body)
    await resave(app, page, note.id, read)
    expect(read()).toBe(body)
  })
})
