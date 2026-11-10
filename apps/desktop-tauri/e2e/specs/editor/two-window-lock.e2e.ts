// A lock set while two windows hold the note open (#3531 14e-3): `vault_locks_set` from one
// window sends `VaultLocksChangedEvent` to both, so both editors stop taking edits and show the
// lock notice; typing in the other window changes nothing; the unlock gives both back. A note
// opened while locked takes edits again once it is unlocked: the editor reopens it on the event.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

interface WindowSwitcher {
  switchToWindow(handle: string): Promise<void>
}

const EDITOR = '[aria-label="Rich text editor"] [contenteditable]'
const NOTICE = '[data-testid="note-locked-indicator"]'

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

/** The lock command as the renderer's lock store calls it. */
async function setLock(page: Page, noteId: string, locked: boolean): Promise<void> {
  await page.evaluate(
    async ({ id, on }: { id: string; on: boolean }) => {
      const tauri = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }
        }
      ).__TAURI__.core
      await tauri.invoke('vault_locks_set', { input: { kind: 'note', target: id, locked: on } })
    },
    { id: noteId, on: locked }
  )
}

async function expectEditable(page: Page, editable: boolean): Promise<void> {
  const editor = page.locator(EDITOR).first()
  await expect.poll(() => editor.getAttribute('contenteditable')).toBe(String(editable))
  await expect.poll(() => page.locator(NOTICE).count()).toBe(editable ? 0 : 1)
}

test('a lock set in one window makes the note read-only in both, and the unlock gives it back', async ({
  app,
  page,
  testVaultPath
}) => {
  const windows = app.executor as unknown as WindowSwitcher
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Two Window Lock ${Date.now().toString(36)}`,
    content: 'Locked body',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  await expectEditable(page, true)

  const second = await invokeTest<string>(app, 'e2e_create_secondary_window')
  await windows.switchToWindow(second)
  await pageReady(page)
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await expectEditable(page, true)

  await windows.switchToWindow('main')
  await setLock(page, note.id, true)
  await expectEditable(page, false)

  await windows.switchToWindow(second)
  await expectEditable(page, false)
  const editor = page.locator(EDITOR).first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' typed while locked')
  await expect(editor).toContainText('Locked body')
  expect(await editor.textContent()).not.toContain('typed while locked')
  const file = join(testVaultPath, note.path)
  expect(readFileSync(file, 'utf8')).not.toContain('typed while locked')

  await setLock(page, note.id, false)
  await expectEditable(page, true)
  await windows.switchToWindow('main')
  await expectEditable(page, true)
})

test('a note opened while locked takes edits again once it is unlocked', async ({ page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Opened Locked ${Date.now().toString(36)}`,
    content: 'Locked at open',
    folder: 'notes'
  })
  await setLock(page, note.id, true)
  await openFromSidebar(page, note)
  await expectEditable(page, false)

  await setLock(page, note.id, false)
  await expectEditable(page, true)
  const editor = page.locator(EDITOR).first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' typed after unlock')
  await expect(editor).toContainText('typed after unlock')
})
