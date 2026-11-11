// The core database opened read-only (Step 14k-4, #3531), the Tauri successor of Electron's
// `crdt-preflight-crash.e2e.ts`. Electron probed its CRDT store in a child process and fell back
// to in-memory documents when the child died. The Tauri app keeps every body in `data.db`, and
// SQLite opens a write-protected file read-only, so the switch is the file's own permission: the
// spec makes `data.db` read-only between launches, as a read-only volume or a copied profile
// does for a user. No test hook is involved, and nothing in the app is told it is under test.
// The editor host then serves in-memory sessions: a window's edits stay in that window, and
// `crdt_get_health` answers `{ persistent: false }`.
import { chmodSync } from 'node:fs'

import { dataDbPath } from '../../harness/damage'
import { blockTexts, typeInEditor } from '../../harness/editor'
import { createNote, NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { gracefulClose, restart, type TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'

interface CrdtHealth {
  persistent: boolean
  inMemorySessions: number
}

const crdtHealth = (page: Page) => invoke<CrdtHealth>(page, 'crdt_get_health')

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

test('opens a working window and takes typing in an in-memory session when the core database is read-only', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const note = await createNote(page, { title: 'Read-only core', content: 'Seeded line' })
  const writable = await relaunchReadOnly(app, testVaultPath)
  try {
    // The real app, not the startup-failure page, with the vault open.
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).not.toContainText("couldn't finish starting")
    await vaultOpen(page)
    expect((await vaultStatus(page)).error).toBeNull()

    // Guards against a vacuous pass: the editor host must see the read-only database.
    const health = await crdtHealth(page)
    expect(health.persistent).toBe(false)
    expect(health.inMemorySessions).toBeGreaterThan(0)

    await openFromSidebar(page, note)
    const editor = page.locator(NOTE_EDITOR).first()
    await editor.waitFor({ state: 'visible', timeout: 15_000 })
    await editor.click()
    await page.keyboard.press('End')
    await typeInEditor(page, ' typed')
    await expect.poll(() => blockTexts(page)).toEqual(['Seeded line typed'])
  } finally {
    writable()
  }
})

// The notice waits for three launches in a row without a persistent store; the Tauri host counts
// only the current launch, so `inMemorySessions` never passes 1 and the notice never shows (#4190).
test.skip('tells the user once the core database has been read-only for three launches (#4190)', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const writable = await relaunchReadOnly(app, testVaultPath)
  try {
    await restart(app)
    await restart(app)
    await vaultOpen(page)
    expect((await crdtHealth(page)).inMemorySessions).toBeGreaterThanOrEqual(3)
    await expect(page.getByText("Edit history isn't being kept on this device")).toBeVisible({
      timeout: 15_000
    })
  } finally {
    writable()
  }
})
