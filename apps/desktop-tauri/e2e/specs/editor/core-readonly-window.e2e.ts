// The core database opened read-only (Step 14k-4, #3531), the Tauri successor of Electron's
// `crdt-preflight-crash.e2e.ts`. Electron probed its CRDT store in a child process and fell back
// to in-memory documents when the child died. The Tauri app keeps every body in `data.db`, and
// SQLite opens a write-protected file read-only, so the switch is the file's own permission: the
// spec makes `data.db` read-only between launches, as a read-only volume or a copied profile
// does for a user. No test hook is involved, and nothing in the app is told it is under test.
// No edit can be stored then, and the note's file is written from the stored body, so the app
// fails closed (#4190): every note opens read-only, the editor refuses typing and says why, and
// the user is told on the first such launch that this device cannot save. The note's title and
// details take no edit either, and a journal day with no note yet takes no typing (#4268).
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { navigateTo } from '../../harness/app-helpers'
import { dataDbPath } from '../../harness/damage'
import { typeInEditor } from '../../harness/editor'
import { createNote, NOTE_TITLE, openFromSidebar, vaultOpen } from '../../harness/notes'
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

/** The renderer's today, as the journal page picks it. */
const today = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })

const journalEntry = (page: Page, date: string) =>
  invoke<{ id: string } | null>(page, 'journal_get_entry', { date })

/** Long enough for the day to load: the editor shown while it loads takes no input anyway. */
const DAY_LOAD_MS = 2_000

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
    expect(health.inMemorySessions).toBeGreaterThan(0)
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

    // The title and the note's details take no edit either (#4268).
    await expect(page.locator(NOTE_TITLE).first()).toBeDisabled()
    await expect(page.getByTestId('ghost-add-details').first()).toBeDisabled()

    // Today has no note yet, so its editor is bound to none and no editor host says it is
    // read-only: the page asks, says why, and takes no typing (#4268).
    const day = await today(page)
    expect(await journalEntry(page, day)).toBeNull()
    await navigateTo(page, 'journal')
    await expect(page.getByTestId('note-database-read-only')).toHaveText(
      "Read-only. This device can't save changes."
    )
    const dayEditor = page.locator('.bn-editor').first()
    await dayEditor.waitFor({ state: 'visible', timeout: 15_000 })
    await sleep(DAY_LOAD_MS)
    await expect(dayEditor).toHaveAttribute('contenteditable', 'false')
    await dayEditor.click()
    await typeInEditor(page, 'typed into today')
    await sleep(WRITE_BACK_SETTLE_MS)
    expect(await dayEditor.innerText()).not.toContain('typed into today')
    expect(await journalEntry(page, day)).toBeNull()
  } finally {
    writable()
  }
})
