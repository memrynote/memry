// The vault write-back in the running app (Step 12e-3h, #3529). Until Steps 13 and 14 name notes
// and edit them, `e2e_vault_adopt_files` makes every new markdown file a note and
// `e2e_note_edit` edits a body the way the editor will. Each way the app quits must leave the
// edit scheduled just before it in the file: the app's own exit (the app menu, a relaunch),
// `[NSApp terminate:]` on macOS (Cmd-Q, the Dock) and a Windows sign-out.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isAlive } from '../../harness/app-process'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { pollUntil, readMainLog } from '../../harness/wait'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

type App = Parameters<typeof invokeTest>[0] & { pid: number }

/** A note for `rel`, whose document holds the file's text. */
async function noteFor(app: App, vault: string, rel: string, text: string): Promise<string> {
  writeFileSync(join(vault, rel), text)
  const row = await pollUntil(
    async () =>
      (await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')).find(
        (file) => file.path === rel && file.contentHash !== null
      ),
    { timeoutMs: 20_000 }
  )
  expect(row).toBeDefined()
  return (row as NoteFile).noteId
}

async function adopted(app: App, vault: string, rel: string): Promise<string> {
  await invokeTest(app, 'e2e_vault_adopt_files')
  return noteFor(app, vault, rel, 'first words\n')
}

async function exited(app: App): Promise<void> {
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
}

test('an edit made in the app reaches its file, and an outside edit reaches the body', async ({
  app,
  testVaultPath
}) => {
  const id = await adopted(app, testVaultPath, 'notes/wb-roundtrip.md')
  const file = join(testVaultPath, 'notes/wb-roundtrip.md')

  await invokeTest(app, 'e2e_note_edit', { noteId: id, text: 'typed in the app' })
  expect(
    await pollUntil(() => readFileSync(file, 'utf8') === 'typed in the app\n', {
      timeoutMs: 10_000
    })
  ).toBe(true)

  writeFileSync(file, 'edited outside\n')
  expect(
    await pollUntil(
      async () =>
        (await invokeTest<string>(app, 'e2e_note_body', { noteId: id })) === 'edited outside',
      { timeoutMs: 10_000 }
    )
  ).toBe(true)
  expect(readMainLog(app.dirs.logDir)).not.toMatch(/the write-back failed/)
})

test('an edit scheduled just before the app exits is in the file, and after the relaunch', async ({
  app,
  testVaultPath
}) => {
  const id = await adopted(app, testVaultPath, 'notes/wb-quit.md')
  const file = join(testVaultPath, 'notes/wb-quit.md')

  await invokeTest(app, 'e2e_note_edit', { noteId: id, text: 'typed before the quit' })
  await invokeTest(app, 'e2e_request_quit')
  await exited(app)
  expect(readFileSync(file, 'utf8')).toBe('typed before the quit\n')

  await restart(app)
  expect(
    await pollUntil(
      async () =>
        (await invokeTest<string>(app, 'e2e_note_body', { noteId: id })) ===
        'typed before the quit',
      { timeoutMs: 20_000 }
    )
  ).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('typed before the quit\n')
})

test('Cmd-Q writes the edit scheduled just before it', async ({ app, testVaultPath }) => {
  test.skip(process.platform !== 'darwin', '[NSApp terminate:] is macOS-only')
  const id = await adopted(app, testVaultPath, 'notes/wb-terminate.md')

  await invokeTest(app, 'e2e_note_edit', { noteId: id, text: 'typed before Cmd-Q' })
  // The app may be gone before the reply.
  await invokeTest(app, 'e2e_app_terminate').catch(() => undefined)
  await exited(app)
  expect(readFileSync(join(testVaultPath, 'notes/wb-terminate.md'), 'utf8')).toBe(
    'typed before Cmd-Q\n'
  )
})

test('a Windows sign-out writes the edit scheduled just before it', async ({
  app,
  testVaultPath
}) => {
  test.skip(process.platform !== 'win32', 'WM_QUERYENDSESSION is Windows-only')
  const id = await adopted(app, testVaultPath, 'notes/wb-sign-out.md')

  await invokeTest(app, 'e2e_note_edit', { noteId: id, text: 'typed before the sign-out' })
  // Windows ends the WebView with the session too; the write-back must not need it.
  await invokeTest(app, 'e2e_send_session_end', { target: 'main', killWebview: true })
  await exited(app)
  expect(readFileSync(join(testVaultPath, 'notes/wb-sign-out.md'), 'utf8')).toBe(
    'typed before the sign-out\n'
  )
})
