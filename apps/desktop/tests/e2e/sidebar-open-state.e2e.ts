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
 * The restart case cannot use `fixtures.ts` (one launch per test, fresh
 * user-data dir per launch), so it drives `launchElectronWithWindow` directly
 * twice against one `userDataDir` — localStorage lives in that dir.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Page } from '@playwright/test'
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sidebar-open-state-userdata-'))

  const first = await launchElectronWithWindow({ testVaultPath, userDataDir })
  try {
    await waitForAppReady(first.page)
    await waitForVaultReady(first.page)
    await collapseSidebar(first.page)
  } finally {
    // Empty dirs list: the user-data dir has to outlive this launch.
    await destroyElectronApp(first.app, [])
  }

  const second = await launchElectronWithWindow({ testVaultPath, userDataDir })
  try {
    await waitForAppReady(second.page)
    await waitForVaultReady(second.page)

    await expect(sidebar(second.page)).toHaveAttribute('data-state', 'collapsed')
  } finally {
    await destroyElectronApp(second.app, [
      second.userDataDir,
      second.resolvedUserDataDir,
      userDataDir
    ])
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
