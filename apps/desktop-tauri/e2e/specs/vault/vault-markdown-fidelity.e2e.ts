// What the write-back writes for a list and for paragraphs (Step 12, #3529). Port of
// `apps/desktop/tests/e2e/vault-markdown-fidelity.e2e.ts` without the editor: its two cases type
// into BlockNote, which Step 14 (#3531) brings, so they move to
// `vault-markdown-fidelity-editor.e2e.ts` then, with the Enter-makes-a-new-block regression.
// Here the blocks come from a file, an edit made in the app retypes the first one
// (`e2e_note_edit`), and the write-back serializes it: an edited list item is written in a tight
// `-` list, and an edit to one paragraph keeps the file's block separation. A second pass of the
// unchanged note writes nothing, so a re-save never grows the file.
import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXPECT_TIMEOUT_MS } from '../../harness/budgets'
import { invokeTest } from '../../harness/invoke-test'
import { gracefulClose } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { pollUntil, readMainLog } from '../../harness/wait'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

type App = Parameters<typeof gracefulClose>[0] & { dirs: { logDir: string } }

/** A note whose document holds `text`, from a file another program wrote. */
async function noteFrom(app: App, path: string, rel: string, text: string): Promise<string> {
  await invokeTest(app, 'e2e_vault_adopt_files')
  writeFileSync(path, text)
  const row = await pollUntil(
    async () =>
      (await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')).find(
        (file) => file.path === rel && file.contentHash !== null
      ),
    { timeoutMs: EXPECT_TIMEOUT_MS }
  )
  if (!row) throw new Error(`no row for ${rel}`)
  return row.noteId
}

/** Retypes the first block in the app and waits for the write-back to put `text` in the file. */
async function editFirst(app: App, noteId: string, path: string, text: string): Promise<string> {
  await invokeTest(app, 'e2e_note_edit', { noteId, text })
  const written = await pollUntil(
    () => {
      const body = readFileSync(path, 'utf8')
      return body.includes(text) ? body : undefined
    },
    { timeoutMs: EXPECT_TIMEOUT_MS }
  )
  if (written === undefined) throw new Error(`the edit never reached ${path}`)
  return written
}

/**
 * Schedules a pass of the unchanged note, then quits: the quit runs every scheduled pass before
 * the app exits (`flush-writebacks`), so the pass has run once the process is gone. It must
 * find the file already saying the body: same bytes, same modified time.
 */
async function resaveAndQuit(app: App, noteId: string, path: string): Promise<void> {
  const before = { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }
  await invokeTest(app, 'e2e_note_schedule', { noteIds: [noteId] })
  await gracefulClose(app)
  expect({ text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }).toEqual(before)
  expect(readMainLog(app.dirs.logDir)).not.toMatch(/the write-back failed/)
}

test('a list item the app edits is written in a tight `-` list, and a re-save writes nothing', async ({
  app,
  testVaultPath
}) => {
  const rel = 'notes/list-fidelity.md'
  const path = join(testVaultPath, rel)
  const id = await noteFrom(app, path, rel, '- kaan\n- sevde\n- karaca\n')

  expect(await editFirst(app, id, path, 'kaan typed')).toBe('- kaan typed\n- sevde\n- karaca\n')
  await resaveAndQuit(app, id, path)
})

test('an edit to one paragraph keeps the file block separation, and a re-save writes nothing', async ({
  app,
  testVaultPath
}) => {
  const rel = 'notes/paragraph-fidelity.md'
  const path = join(testVaultPath, rel)
  const id = await noteFrom(app, path, rel, 'line1\n\nline2\n\nline3\n')

  expect(await editFirst(app, id, path, 'line1 typed')).toBe('line1 typed\n\nline2\n\nline3\n')
  await resaveAndQuit(app, id, path)
})
