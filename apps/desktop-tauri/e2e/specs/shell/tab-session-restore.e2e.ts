// The open note tab comes back after a restart on the same profile, as in Electron, and the
// launch stamps `memry:note-readable` once (#3547; Step 40's `renderer_note_readable_ms`). The
// stored tab state is read before the UI is touched, which tells a lost quit-time write (missing
// only after an immediate quit), a store that is not kept (missing after every quit) and a
// renderer restore bug (stored, but no tab) apart. The SIGTERM case is the launch bench's quit.
import { isAlive } from '../../harness/app-process'
import { SELECTORS } from '../../harness/app-helpers'
import { openNoteByHandle } from '../../harness/note-sync-helpers'
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

type Quit = 'after auto-save' | 'immediately' | 'by SIGTERM'

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
  if (quit === 'by SIGTERM') {
    process.kill(app.pid, 'SIGTERM')
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
  for (const quit of ['after auto-save', 'immediately', 'by SIGTERM'] as const) {
    test(`restores the open note tab after quitting ${quit}`, async ({ app, page }) => {
      test.slow()
      const title = await openNoteAndQuit(app, page, quit)
      await expectNoteRestored(page, title)
    })
  }
})
