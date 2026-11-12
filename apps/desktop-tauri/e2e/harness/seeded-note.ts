// Notes seeded as bytes on disk, opened in the editor and saved by the write-back, for the specs
// whose claim is about bytes a user or another program wrote (Step 14z, #3531): the `.md` is read
// back with `fs`, never through a helper that normalizes it.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { SELECTORS } from './app-helpers'
import { invokeTest } from './invoke-test'
import {
  getNoteHandleByTitle,
  openNoteByTitle,
  type WritebackDebugState
} from './note-sync-helpers'
import { NOTE_EDITOR } from './notes'
import { expect } from './pw-compat/expect'
import type { Page } from './pw-compat/page'
import type { TauriApp } from './tauri-lifecycle'

export function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/** The file's bytes and mtime from one open handle, so both describe the same file. */
export function readWithMtime(absPath: string): { bytes: string; mtimeMs: number } {
  const fd = fs.openSync(absPath, 'r')
  try {
    return { bytes: fs.readFileSync(fd, 'utf8'), mtimeMs: fs.fstatSync(fd).mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The bytes and mtime the file settles on once the app has indexed it. Taking the baseline after
 * the file stops moving makes the later comparison mean "did opening or saving it change
 * anything".
 */
export async function indexedBaseline(
  page: Page,
  title: string,
  absPath: string
): Promise<{ id: string; bytes: string; mtimeMs: number }> {
  const note = await getNoteHandleByTitle(page, title)
  let last = readWithMtime(absPath)
  // Two consecutive identical reads a second apart: the file has stopped moving.
  await expect
    .poll(
      () => {
        const next = readWithMtime(absPath)
        const settled = next.bytes === last.bytes && next.mtimeMs === last.mtimeMs
        last = next
        return settled
      },
      { timeout: 20_000, intervals: [1000] }
    )
    .toBe(true)
  return { id: note.id, ...last }
}

export async function openInEditor(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(
    () => Boolean((window as unknown as { __memryActiveEditor?: unknown }).__memryActiveEditor),
    undefined,
    { timeout: 30_000 }
  )
}

/**
 * An edit and its undoing at the end of the document, through the editor API: a click lands a
 * caret, and where the caret sits changes what a fence or a hard break serializes to. Opening a
 * note alone schedules no write-back, so a spec that only opened it would assert on a file the
 * app never saved.
 */
export async function nudgeDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = (
      window as unknown as {
        __memryActiveEditor?: {
          document: Array<{ id: string }>
          insertBlocks(blocks: unknown[], ref: string, where: 'after'): unknown
          removeBlocks(ids: string[]): unknown
        }
      }
    ).__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const before = editor.document.map((block) => block.id)
    editor.insertBlocks(
      [{ type: 'paragraph', content: [{ type: 'text', text: 'nudge', styles: {} }] }],
      before[before.length - 1],
      'after'
    )
    const added = editor.document.filter((block) => !before.includes(block.id))
    editor.removeBlocks(added.map((block) => block.id))
  })
}

export const writebackDebug = (app: TauriApp, noteId: string) =>
  invokeTest<WritebackDebugState | null>(app, 'e2e_writeback_debug_state', { noteId })

/** Waits until more than `after` write-back passes of the note ran and none is due. */
export async function waitForWritebackToSettle(
  app: TauriApp,
  noteId: string,
  after = 0
): Promise<void> {
  await expect
    .poll(
      async () => {
        const debug = await writebackDebug(app, noteId)
        return {
          performed: (debug?.performedCount ?? 0) > after,
          pending: debug?.pending ?? true
        }
      },
      { timeout: 30_000 }
    )
    .toEqual({ performed: true, pending: false })
}

/**
 * Runs one write-back pass over the note's document as it is now, as the sync driver schedules
 * one after a pull, and waits for it. The pass serializes the document and compares it with the
 * file, so a byte check after it says what saving the open document does, and it cannot pass
 * because nothing saved.
 */
export async function passOverDocument(app: TauriApp, noteId: string): Promise<void> {
  const before = (await writebackDebug(app, noteId))?.performedCount ?? 0
  await invokeTest(app, 'e2e_note_schedule', { noteIds: [noteId] })
  await waitForWritebackToSettle(app, noteId, before)
}

/** Closes the note's tab from its close button, as a user does. */
export async function closeNoteTab(page: Page, title: string): Promise<void> {
  const tab = page.locator(SELECTORS.tab).filter({ hasText: title }).first()
  await expect(tab).toBeVisible()
  await tab.hover()
  const closeButton = tab.locator('button[aria-label^="Close"]').first()
  await closeButton.click()
  await expect(tab).toBeHidden()
}
