// Port of the Vault Creation Flow, Vault Opening/Switching and Vault Error Handling blocks of
// `apps/desktop/tests/e2e/vault.e2e.ts`. The Vault Reindexing block needs `vault_reindex`,
// which Step 13 (#3530) adds together with that block. Folder choices are answered through
// the dialog queue; no native dialog opens.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import type { Page } from '../../harness/pw-compat/page'
import { removeDir } from '../../harness/remove-dir'
import { test, expect } from '../../harness/test'
import { invoke, type SelectResponse, vaultList, vaultStatus } from '../../harness/vault-commands'
import { readMainLog } from '../../harness/wait'

const real = (path: string): string => realpathSync(path)

/**
 * An error the vault file tier logged (`logging/format.rs` writes `ts [error] [scope]`). Other
 * scopes log errors of their own here: the renderer's not-ported calls, and on a Linux runner
 * without `update-desktop-database` the deep-link plugin (#3772).
 */
const VAULT_ERROR = /\[error\] \[vault_(consumer|writeback)\]/

/** A parent folder under the temp dir, removed by the caller. */
function tempParent(): string {
  return mkdtempSync(join(tmpdir(), 'memry-e2e-parent-'))
}

test('opens the registered vault at launch and lays out the core databases', async ({
  app,
  page,
  testVaultPath
}) => {
  const status = await vaultStatus(page)
  expect(status.isOpen).toBe(true)
  expect(real(status.path as string)).toBe(real(testVaultPath))
  expect(existsSync(join(testVaultPath, '.memry', 'core', 'data.db'))).toBe(true)
  expect(existsSync(join(testVaultPath, '.memry', 'core', 'index.db'))).toBe(true)
  // The sidebar draws the vault's folder name.
  await expect(page.getByText(basename(testVaultPath)).first()).toBeVisible({ timeout: 30_000 })
  const log = readMainLog(app.dirs.logDir)
  expect(log).toContain('vault open')
  expect(log).not.toMatch(VAULT_ERROR)
})

/**
 * Windows will not delete a vault whose databases the app still has open, so close it first.
 * A failure is logged and the removal below reports the real problem.
 */
async function closeVault(page: Page): Promise<void> {
  await invoke(page, 'vault_close').catch((error: unknown) => {
    console.warn('vault_close before cleanup failed', error)
  })
}

test('creates a vault under a path with spaces and non-ASCII, and restores it after a restart', async ({
  app,
  page
}) => {
  const parent = join(tempParent(), 'Mein Ordner ünï')
  try {
    const created = await invoke<SelectResponse>(page, 'vault_create', {
      parentPath: parent,
      name: 'Notizen Ärger'
    })
    expect(created.success).toBe(true)
    const vaultPath = join(parent, 'Notizen Ärger')
    expect(created.vault?.name).toBe('Notizen Ärger')
    expect(existsSync(join(vaultPath, '.memry', 'core', 'data.db'))).toBe(true)

    await restart(app)

    const status = await vaultStatus(page)
    expect(status.isOpen).toBe(true)
    expect(real(status.path as string)).toBe(real(vaultPath))
    expect(readMainLog(app.dirs.logDir)).not.toMatch(VAULT_ERROR)
  } finally {
    await closeVault(page)
    removeDir(join(parent, '..'))
  }
})

test('refuses a taken, hidden or separator name with the contract error code', async ({ page }) => {
  const parent = tempParent()
  try {
    mkdirSync(join(parent, 'Taken'))
    const taken = await invoke<SelectResponse>(page, 'vault_create', {
      parentPath: parent,
      name: 'Taken'
    })
    expect(taken).toMatchObject({ success: false, errorCode: 'already-exists' })
    for (const name of ['.hidden', 'a/b', 'a:b', 'a|b', '   ']) {
      const bad = await invoke<SelectResponse>(page, 'vault_create', { parentPath: parent, name })
      expect(bad).toMatchObject({ success: false, errorCode: 'invalid-name' })
    }
    expect(existsSync(join(parent, '.hidden'))).toBe(false)
    // The open vault was not disturbed.
    expect((await vaultStatus(page)).isOpen).toBe(true)
  } finally {
    removeDir(parent)
  }
})

test('switches vaults without a closed status in between, forgets one and sets the default', async ({
  page,
  testVaultPath
}) => {
  const parent = tempParent()
  const second = join(parent, 'Second')
  mkdirSync(second)
  try {
    await page.evaluate(() => {
      const seen: unknown[] = []
      ;(window as unknown as { __statuses: unknown[] }).__statuses = seen
      return (
        window as unknown as {
          __TAURI__: {
            event: { listen(name: string, cb: (e: { payload: unknown }) => void): Promise<unknown> }
          }
        }
      ).__TAURI__.event
        .listen('vault-status-changed-event', (event) => seen.push(event.payload))
        .then(() => true)
    })

    const switched = await invoke<SelectResponse>(page, 'vault_switch', { path: second })
    expect(switched.success).toBe(true)
    const statuses = await page.evaluate(
      () =>
        (window as unknown as { __statuses: { isOpen: boolean; path: string | null }[] }).__statuses
    )
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((status) => status.isOpen)).toBe(true)
    expect(real((await vaultStatus(page)).path as string)).toBe(real(second))

    // Both vaults are listed, the first one stays the default.
    const list = await vaultList(page)
    expect(list.vaults.map((vault) => vault.path).toSorted()).toEqual(
      [testVaultPath, second].toSorted()
    )
    expect(list.vaults.filter((vault) => vault.isDefault).map((vault) => vault.path)).toEqual([
      testVaultPath
    ])

    await invoke(page, 'vault_set_default', { path: second })
    const after = await vaultList(page)
    expect(after.vaults.filter((vault) => vault.isDefault).map((vault) => vault.path)).toEqual([
      second
    ])

    // Forgetting the vault closes it, drops it from the list and leaves its folder alone.
    await invoke(page, 'vault_remove', { path: second })
    const forgotten = await vaultList(page)
    expect(forgotten.vaults.map((vault) => vault.path)).toEqual([testVaultPath])
    expect(forgotten.currentVault).toBeNull()
    expect((await vaultStatus(page)).isOpen).toBe(false)
    expect(existsSync(join(second, '.memry', 'core', 'data.db'))).toBe(true)
  } finally {
    removeDir(parent)
  }
})

test('asks the shell to reveal the open vault', async ({ app, page, testVaultPath }) => {
  await invoke(page, 'vault_reveal', { path: testVaultPath })
  expect(await invokeTest<string[]>(app, 'e2e_revealed_paths')).toEqual([testVaultPath])
})

test('opens the folder the dialog queue answers, and reports a cancelled picker', async ({
  app,
  page
}) => {
  const parent = tempParent()
  const folder = join(parent, 'Picked')
  mkdirSync(folder)
  try {
    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'OpenFolder', paths: [folder] })
    const picked = await invoke<SelectResponse>(page, 'vault_select', { path: null })
    expect(picked.success).toBe(true)
    expect(real(picked.vault?.path as string)).toBe(real(folder))

    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'OpenFolder', paths: [] })
    const cancelled = await invoke<SelectResponse>(page, 'vault_select', { path: null })
    expect(cancelled).toMatchObject({ success: false, error: 'No folder selected' })
    // The vault the cancel left alone is still open.
    expect(real((await vaultStatus(page)).path as string)).toBe(real(folder))
  } finally {
    await closeVault(page)
    removeDir(parent)
  }
})

test('a folder that is not there is an error, and the vault being worked in stays open', async ({
  page,
  testVaultPath
}) => {
  const missing = join(tmpdir(), 'memry-e2e-does-not-exist', 'vault')
  for (const command of ['vault_select', 'vault_switch']) {
    const result = await invoke<SelectResponse>(page, command, { path: missing })
    expect(result.success).toBe(false)
    expect(result.error).toBe('Selected path is not a valid directory')
  }
  const status = await vaultStatus(page)
  expect(status.isOpen).toBe(true)
  expect(real(status.path as string)).toBe(real(testVaultPath))
})

test('a damaged vault config.json does not stop the list, and a vanished folder reads as missing', async ({
  page,
  testVaultPath
}) => {
  mkdirSync(join(testVaultPath, '.memry'), { recursive: true })
  writeFileSync(join(testVaultPath, '.memry', 'config.json'), 'invalid json content')
  const list = await vaultList(page)
  const entry = list.vaults.find((vault) => vault.path === testVaultPath)
  expect(entry?.isMissing).toBe(false)
  expect(entry?.accentColor).toBe('#f97316')
  expect(entry?.icon).toBeUndefined()
})
