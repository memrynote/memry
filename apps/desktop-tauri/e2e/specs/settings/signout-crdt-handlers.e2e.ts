// Ported from apps/desktop/tests/e2e/signout-crdt-handlers.e2e.ts. Electron's sign-out teardown
// once unregistered the `crdt:*` handlers, so the renderer's late `closeDoc` (React cleanup runs
// after the teardown) hit a missing handler. Here the teardown is the real `sync_logout` command,
// not Electron's `simulateCrdtTeardownForTests` hook: the editor commands must keep serving the
// open vault after it.
import { test, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'
import { createNote, vaultOpen } from '../../harness/notes'
import { invoke } from '../../harness/vault-commands'
import { readMainLog } from '../../harness/wait'

interface TauriWindow {
  __TAURI__: {
    core: {
      invoke: (command: string, args?: unknown) => Promise<unknown>
      Channel: new () => object
    }
  }
}

/** Opens the note's doc; the answer is binary, so the page reports only that it arrived. */
const openDoc = (page: Page, noteId: string): Promise<string> =>
  page.evaluate(async (id: string) => {
    const tauri = (window as unknown as TauriWindow).__TAURI__.core
    await tauri.invoke('crdt_open_doc', { noteId: id, onUpdate: new tauri.Channel() })
    return 'opened'
  }, noteId)

const CRDT_FAILURE = /command failed.*crdt_|crdt_.*command failed/

test('sign-out leaves the CRDT commands serving the open vault', async ({ app, page }) => {
  await vaultOpen(page)
  const note = await createNote(page, { title: 'signout-crdt-test', content: '' })
  expect(await openDoc(page, note.id)).toBe('opened')
  const logBefore = readMainLog(app.dirs.logDir).length

  const signedOut = await invoke<{ success: boolean }>(page, 'sync_logout')
  expect(signedOut.success).toBe(true)

  // The late close of React's cleanup, then a fresh open: both still answer.
  expect(await invoke<null>(page, 'crdt_close_doc', { noteId: note.id })).toBeNull()
  expect(await openDoc(page, note.id)).toBe('opened')

  const offenders = readMainLog(app.dirs.logDir)
    .slice(logBefore)
    .split('\n')
    .filter((line) => CRDT_FAILURE.test(line))
  expect(offenders).toEqual([])
})
