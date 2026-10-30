// What the write-back writes for a list and for paragraphs (Step 12, #3529). Port of
// `apps/desktop/tests/e2e/vault-markdown-fidelity.e2e.ts` without the editor: its two cases type
// into BlockNote, which Step 14 (#3531) brings, so they move to
// `vault-markdown-fidelity-editor.e2e.ts` then. Here the blocks come from a file, an edit made
// in the app retypes the first one (`e2e_note_edit`), and the write-back serializes it. Both
// regressions the Electron spec guards are checked on the written bytes: a list that comes back
// loose or with `*` markers, and paragraphs joined by a soft break or a trailing backslash. A
// second pass of an unchanged note writes nothing, so a re-save never grows the file.
import { invokeTest } from '../../harness/invoke-test'
import { test, expect } from '../../harness/test'
import { pollUntil, readMainLog } from '../../harness/wait'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

interface VaultFile {
  text: string
  mtimeMs: number
}

type App = Parameters<typeof invokeTest>[0] & { dirs: { logDir: string } }

const read = async (app: App, rel: string): Promise<VaultFile> =>
  (await invokeTest<VaultFile | null>(app, 'e2e_vault_read_file', { path: rel })) as VaultFile

/** A note whose document holds `text`, from a file another program wrote. */
async function noteFrom(app: App, rel: string, text: string): Promise<string> {
  await invokeTest(app, 'e2e_vault_adopt_files')
  await invokeTest(app, 'e2e_vault_write_outside', { path: rel, text, replace: false })
  const row = await pollUntil(
    async () =>
      (await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')).find(
        (file) => file.path === rel && file.contentHash !== null
      ),
    { timeoutMs: 20_000 }
  )
  if (!row) throw new Error(`no row for ${rel}`)
  return row.noteId
}

/** Retypes the first block in the app and waits for the write-back to put `marker` in the file. */
async function editFirst(app: App, noteId: string, rel: string, text: string): Promise<string> {
  await invokeTest(app, 'e2e_note_edit', { noteId, text })
  const written = await pollUntil(
    async () => {
      const file = await read(app, rel)
      return file.text.includes(text) ? file.text : undefined
    },
    { timeoutMs: 20_000 }
  )
  if (written === undefined) throw new Error(`the edit never reached ${rel}`)
  return written
}

/** Schedules a pass of the unchanged note: it must find the file saying the body already. */
async function resave(app: App, noteId: string, rel: string): Promise<void> {
  const before = await read(app, rel)
  const unchanged = new RegExp(`note_id=${noteId}\\b.*Unchanged`, 'g')
  const passes = (readMainLog(app.dirs.logDir).match(unchanged) ?? []).length
  await invokeTest(app, 'e2e_note_schedule', { noteIds: [noteId] })
  const ran = await pollUntil(
    () => (readMainLog(app.dirs.logDir).match(unchanged) ?? []).length > passes,
    { timeoutMs: 20_000, intervalMs: 200 }
  )
  if (!ran) throw new Error('no pass after the schedule')
  const after = await read(app, rel)
  expect(after.text).toBe(before.text)
  expect(after.mtimeMs).toBe(before.mtimeMs)
}

test('a list item the app edits is written in a tight `-` list, and a re-save writes nothing', async ({
  app
}) => {
  const rel = 'notes/list-fidelity.md'
  const id = await noteFrom(app, rel, '- kaan\n- sevde\n- karaca\n')

  const body = await editFirst(app, id, rel, 'kaan typed')
  expect(body).toBe('- kaan typed\n- sevde\n- karaca\n')
  expect(body).not.toMatch(/^\* /m)
  expect(body).not.toContain('\n\n- ')

  await resave(app, id, rel)
  expect(readMainLog(app.dirs.logDir)).not.toMatch(/the write-back failed/)
})

test('paragraphs the app edits stay separate blocks, with no soft or hard breaks, and a re-save writes nothing', async ({
  app
}) => {
  const rel = 'notes/paragraph-fidelity.md'
  const id = await noteFrom(app, rel, 'line1\n\nline2\n\nline3\n')

  const body = await editFirst(app, id, rel, 'line1 typed')
  expect(body).toBe('line1 typed\n\nline2\n\nline3\n')
  expect(body).not.toContain('line1 typed\nline2')
  expect(body).not.toMatch(/\\\n/)

  await resave(app, id, rel)
  expect(readMainLog(app.dirs.logDir)).not.toMatch(/the write-back failed/)
})
