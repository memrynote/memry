/**
 * Sidebar open-state persistence E2E.
 *
 * The packaged renderer is loaded with `loadFile()`, so its origin is `file://`
 * and Chromium drops every cookie written there. The old cookie-backed open
 * state therefore never survived anything, while a dev run over
 * `http://localhost` kept working — which is why the bug shipped. These two
 * cases run against the built bundle, so they exercise the real `file://`
 * origin the user has.
 *
 * The restart case cannot use `fixtures.ts`, which launches once per test with
 * a fresh user-data dir. It launches through the shared helper, then relaunches
 * with that first process's own `spawnfile` and `spawnargs`, which already
 * carry the resolved Electron binary, the main entry and `--user-data-dir`.
 * Reusing them keeps the second launch byte-identical to the first without
 * editing anything under `utils/`. That matters: Playwright's `--only-changed`
 * follows the import graph, and every spec reaches `utils/electron-lifecycle.ts`
 * through `fixtures.ts`, so touching it makes the changed-E2E job run all 593
 * specs and blow its 35 minute budget.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'

function makeVault(prefix: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  return vaultPath
}

// Only the desktop branch of `Sidebar` carries data-state; the `collapsible="none"`
// and mobile Sheet branches share data-slot but emit neither data-state nor data-side.
function sidebar(page: Page) {
  return page.locator('[data-slot="sidebar"][data-side="left"]')
}

async function collapseSidebar(page: Page): Promise<void> {
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
  await page
    .getByRole('button', { name: /toggle sidebar/i })
    .first()
    .click()
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
}

test('a collapsed sidebar is still collapsed after a restart', async () => {
  const testVaultPath = makeVault('memry-sidebar-open-state-vault-')

  const first = await launchElectronWithWindow({ testVaultPath })
  const spawned = first.app.process()
  const executablePath = spawned.spawnfile
  const args = spawned.spawnargs.slice(1)
  const userDataDirs = [first.userDataDir, first.resolvedUserDataDir]

  try {
    await waitForAppReady(first.page)
    await waitForVaultReady(first.page)
    await collapseSidebar(first.page)
  } finally {
    // Empty dirs list: the user-data dir holds the localStorage the relaunch reads.
    await destroyElectronApp(first.app, [])
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: testVaultPath,
    MEMRY_TEST_LOG_DIR: path.join(first.userDataDir, 'logs')
  }
  delete env.ELECTRON_RUN_AS_NODE

  const second = await electron.launch({ executablePath, args, env })
  try {
    const page = await second.firstWindow({ timeout: 45_000 })
    await page.waitForLoadState('domcontentloaded')
    await waitForAppReady(page)
    await waitForVaultReady(page)

    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  } finally {
    await destroyElectronApp(second, userDataDirs)
    fs.rmSync(testVaultPath, { recursive: true, force: true })
  }
})

test('a collapsed sidebar is still collapsed after switching vaults', async ({ page }) => {
  await waitForAppReady(page)
  await waitForVaultReady(page)

  await collapseSidebar(page)

  // App.tsx renders `<SidebarProvider key={vaultPath}>`, so opening another
  // vault remounts the provider and re-runs its state initializer.
  const secondVaultPath = makeVault('memry-sidebar-open-state-second-')
  try {
    const created = await page.evaluate(
      (p) => window.api.vault.create(p, 'Sidebar Second Vault'),
      secondVaultPath
    )
    expect(created.success, created.error).toBe(true)
    await waitForVaultReady(page)

    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  } finally {
    fs.rmSync(secondVaultPath, { recursive: true, force: true })
  }
})
