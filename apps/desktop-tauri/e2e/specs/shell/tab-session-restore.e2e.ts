// The open note tab comes back after a restart on the same profile, as in Electron, and the
// launch stamps `memry:note-readable` once (#3547; Step 40's `renderer_note_readable_ms`). The
// stored tab state is read before the UI is touched, which tells a lost quit-time write (missing
// only after an immediate quit), a store that is not kept (missing after every quit) and a
// renderer restore bug (stored, but no tab) apart. The signal case is the launch bench's quit.
import { spawnSync } from 'node:child_process'

import { isAlive } from '../../harness/app-process'
import { SELECTORS } from '../../harness/app-helpers'
import { openNoteByHandle } from '../../harness/note-sync-helpers'
import { HarnessError } from '../../harness/errors'
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { restart, type TauriApp } from '../../harness/tauri-lifecycle'
import { pollUntil, sleep } from '../../harness/wait'

const KEY_PREFIX = 'memry_tab_state:'

/** Every vault-scoped tab state the webview store holds. */
const storedTabStates = (page: Page): Promise<string[]> =>
  page.evaluate((prefix: string) => {
    const found: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) found.push(localStorage.getItem(key) ?? '')
    }
    return found
  }, KEY_PREFIX)

/**
 * The case covers the launch bench's quit (`quit` in scripts/launch-bench-app.mjs). Windows has no
 * signals: Node's `process.kill(pid, 'SIGTERM')` there is `TerminateProcess`, which runs no
 * `beforeunload`, close flush or quit step. The store then kept only what the 1 s auto-save had
 * written by that moment, and the case passed or failed on timing (35 of 49 Windows CI attempts
 * failed). `taskkill` without `/F`, the bench's own Windows quit, posts WM_CLOSE, which takes the
 * window's flush-and-close (`windows/close.rs`). Electron's specs have no signal-quit case.
 */
const SIGNAL_QUIT = process.platform === 'win32' ? 'by WM_CLOSE' : 'by SIGTERM'

type Quit = 'after auto-save' | 'immediately' | typeof SIGNAL_QUIT

function requestQuit(pid: number): void {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGTERM')
    return
  }
  const result = spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new HarnessError(
      `taskkill /PID ${pid} exited with ${result.status}: ${result.stdout}${result.stderr}`
    )
  }
}

async function openNoteAndQuit(app: TauriApp, page: Page, quit: Quit): Promise<string> {
  await vaultOpen(page)
  const title = `Restored Tab ${Math.random().toString(36).slice(2, 8)}`
  const note = await createNote(page, { title, content: 'Body.' })
  await openNoteByHandle(page, { id: note.id, title })
  if (quit === 'after auto-save') {
    await expect
      .poll(async () => (await storedTabStates(page)).some((raw) => raw.includes(title)))
      .toBe(true)
    await sleep(3_000)
  }
  if (quit === SIGNAL_QUIT) {
    requestQuit(app.pid)
    const exited = await pollUntil(() => !isAlive(app.pid) || undefined, {
      timeoutMs: 20_000,
      intervalMs: 100
    })
    expect(exited).toBe(true)
  }
  await restart(app)
  return title
}

async function expectNoteRestored(page: Page, title: string): Promise<void> {
  // Read before any UI call, so nothing this spec does writes the state it checks.
  expect((await storedTabStates(page)).some((raw) => raw.includes(title))).toBe(true)

  await vaultOpen(page)
  const tab = page.locator(SELECTORS.tab).filter({ hasText: title }).first()
  await expect.poll(() => tab.isVisible().catch(() => false), { timeout: 30_000 }).toBe(true)
  await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(title)
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName('memry:note-readable').length), {
      timeout: 30_000
    })
    .toBe(1)
}

test.describe('tab session restore', () => {
  for (const quit of ['after auto-save', 'immediately', SIGNAL_QUIT] as const) {
    test(`restores the open note tab after quitting ${quit}`, async ({ app, page }) => {
      test.slow()
      const title = await openNoteAndQuit(app, page, quit)
      await expectNoteRestored(page, title)
    })
  }
})
