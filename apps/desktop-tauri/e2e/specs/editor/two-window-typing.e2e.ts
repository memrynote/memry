// Two windows of one app edit one note (#3531 14b-2): each window's editor is bound to the note's
// document in the core through the `crdt_*` commands, the host sends each window's edit to the
// other window's channel, and the write-back puts both edits in the file. Each window records the
// commands its page invokes, so the edits are known to travel as document updates and not as
// whole-markdown saves, which would also reach the other window by a reload.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

interface WindowSwitcher {
  switchToWindow(handle: string): Promise<void>
}

/**
 * Records the name of every command the window's page invokes from now on. Tauri's `invoke` is
 * read-only, and it posts each call to its IPC protocol through `fetch`, at `ipc://localhost/<cmd>`
 * (`http://ipc.localhost/<cmd>` on Windows).
 */
async function recordInvokes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __memryInvoked: string[] }
    const fetch = window.fetch.bind(window)
    target.__memryInvoked = []
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (/^(ipc:\/\/localhost|https?:\/\/ipc\.localhost)\//.test(url)) {
        target.__memryInvoked.push(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)))
      }
      return fetch(input, init)
    }
  })
}

/** The window's page has loaded far enough to call commands. */
async function pageReady(page: Page): Promise<void> {
  const ready = await pollUntil(
    async () => {
      try {
        return await page.evaluate(() => typeof window.__TAURI__?.core?.invoke === 'function')
      } catch {
        return false
      }
    },
    { timeoutMs: 30_000 }
  )
  expect(ready).toBe(true)
}

const invoked = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __memryInvoked: string[] }).__memryInvoked)

test('typing in one window reaches the other window, both ways, and the file', async ({
  app,
  page,
  testVaultPath
}) => {
  const windows = app.executor as unknown as WindowSwitcher
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Two Windows ${Date.now().toString(36)}`,
    content: 'Shared body',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await expect(editor).toContainText('Shared body')

  const second = await invokeTest<string>(app, 'e2e_create_secondary_window')
  await windows.switchToWindow(second)
  await pageReady(page)
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await expect(editor).toContainText('Shared body')
  await recordInvokes(page)
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' typed in B')
  await expect.poll(() => invoked(page)).toContain('crdt_apply_update')
  expect(await invoked(page)).not.toContain('notes_update')

  await windows.switchToWindow('main')
  await expect(editor).toContainText('Shared body typed in B')
  await recordInvokes(page)
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' and in A')
  await expect.poll(() => invoked(page)).toContain('crdt_apply_update')
  expect(await invoked(page)).not.toContain('notes_update')

  await windows.switchToWindow(second)
  await expect(editor).toContainText('Shared body typed in B and in A')

  const file = join(testVaultPath, note.path)
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Shared body typed in B and in A')
})
