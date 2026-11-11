// The core database opened read-only (Step 14k-4, #3531), the Tauri successor of Electron's
// `crdt-preflight-crash.e2e.ts`. Electron probed its CRDT store in a child process and fell back
// to in-memory documents when the child died. The Tauri app keeps every body in `data.db`, and
// SQLite opens a write-protected file read-only, so the switch is the file's own permission: the
// spec makes `data.db` read-only between launches, as a read-only volume or a copied profile
// does for a user. No test hook is involved, and nothing in the app is told it is under test.
// No edit can be stored then, and the note's file is written from the stored body, so the app
// fails closed (#4190): every note opens read-only, the editor refuses typing and says why, and
// the user is told on the first such launch that this device cannot save.
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataDbPath } from '../../harness/damage'
import { typeInEditor } from '../../harness/editor'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { gracefulClose, restart, type TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil, sleep } from '../../harness/wait'

interface CrdtHealth {
  persistent: boolean
  inMemorySessions: number
}

const crdtHealth = (page: Page) => invoke<CrdtHealth>(page, 'crdt_get_health')

/** The note's editor, editable or not. */
const EDITOR_SURFACE = '[aria-label="Rich text editor"] [contenteditable]'

/** Longer than the write-back's quiet period, so a write it scheduled would have landed. */
const WRITE_BACK_SETTLE_MS = 5_000

/**
 * Relaunches the app with `data.db` write-protected and returns the step that gives the file
 * back its write permission, which the fixture's cleanup needs on Windows to delete it.
 */
async function relaunchReadOnly(app: TauriApp, vault: string): Promise<() => void> {
  const database = dataDbPath(vault)
  await gracefulClose(app)
  chmodSync(database, 0o444)
  await restart(app)
  return () => chmodSync(database, 0o644)
}

test('opens notes read-only, refuses typing visibly and leaves the file alone when the core database is read-only', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await createNote(page, { title: 'Read-only core', content: 'Seeded line' })
  const file = join(testVaultPath, note.path)
  expect(
    await pollUntil(() => readFileSync(file, 'utf8').includes('Seeded line'), {
      timeoutMs: 15_000
    })
  ).toBe(true)
  const writable = await relaunchReadOnly(app, testVaultPath)
  try {
    const before = readFileSync(file)
    // The real app, not the startup-failure page, with the vault open.
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).not.toContainText("couldn't finish starting")
    await vaultOpen(page)
    expect((await vaultStatus(page)).error).toBeNull()

    // Guards against a vacuous pass: the editor host must see the read-only database.
    const health = await crdtHealth(page)
    expect(health.persistent).toBe(false)
    // Told on the first read-only launch, not the third.
    expect(health.inMemorySessions).toBe(1)
    await expect(page.getByText("This device can't save changes", { exact: true })).toBeVisible({
      timeout: 15_000
    })

    await openFromSidebar(page, note)
    const editor = page.locator(EDITOR_SURFACE).first()
    await editor.waitFor({ state: 'visible', timeout: 15_000 })
    await expect(page.getByTestId('note-database-read-only')).toHaveText(
      "Read-only. This device can't save changes."
    )
    await expect(editor).toHaveAttribute('contenteditable', 'false')
    await expect(editor).toHaveText('Seeded line')
    await editor.click()
    await typeInEditor(page, ' typed')
    await sleep(WRITE_BACK_SETTLE_MS)
    expect((await editor.innerText()).trim()).toBe('Seeded line')
    expect(readFileSync(file).equals(before)).toBe(true)
  } finally {
    writable()
  }
})
