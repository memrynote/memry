// A collapsed sidebar stays collapsed across a restart and a vault switch. Ported from Electron's
// `sidebar-open-state.e2e.ts` (#3547 30h). Electron's bug was a cookie-backed open state the
// packaged `file://` origin dropped; the Tauri webview keeps renderer state in the per-profile
// localStorage, so the restart case relaunches against the same app-data dir.
import { dirname } from 'node:path'

import { waitForAppReady } from '../../harness/app-helpers'
import { appReady } from '../../harness/app-ready'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { restart } from '../../harness/tauri-lifecycle'
import { type SelectResponse, invoke, vaultStatus } from '../../harness/vault-commands'

async function ready(page: Page): Promise<void> {
  await appReady(page)
  await waitForAppReady(page)
}

// Only the desktop branch of `Sidebar` carries data-state; the `collapsible="none"` and mobile
// Sheet branches share data-slot but emit neither data-state nor data-side. The vault stack
// (App.tsx `VaultStack`, as in Electron) keeps the previous vault's workspace mounted in a hidden
// <Activity>, so after a switch the DOM holds two left sidebars: only the shown one counts.
function shownSidebarStates(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="sidebar"][data-side="left"]'))
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => node.getAttribute('data-state'))
  )
}

async function expectSidebar(page: Page, state: 'expanded' | 'collapsed'): Promise<void> {
  await expect.poll(() => shownSidebarStates(page)).toEqual([state])
}

async function collapseSidebar(page: Page): Promise<void> {
  await expectSidebar(page, 'expanded')
  await page
    .getByRole('button', { name: /toggle sidebar/i })
    .first()
    .click()
  await expectSidebar(page, 'collapsed')
}

test('a collapsed sidebar is still collapsed after a restart', async ({ app, page }) => {
  await ready(page)
  await collapseSidebar(page)

  await restart(app)
  await ready(page)

  await expectSidebar(page, 'collapsed')
})

test('a collapsed sidebar is still collapsed after switching vaults', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const firstVault = (await vaultStatus(page)).path

  await collapseSidebar(page)

  // App.tsx renders `<SidebarProvider key={vaultPath}>`, so opening another vault remounts the
  // provider and re-runs its state initializer.
  // Next to the fixture vault, so the fixture removes it after the app has closed (an open vault
  // holds its database files, which Windows will not delete).
  const created = await invoke<SelectResponse>(page, 'vault_create', {
    parentPath: dirname(testVaultPath),
    name: 'Sidebar Second Vault'
  })
  expect(created.success).toBe(true)
  await expect
    .poll(async () => {
      const status = await vaultStatus(page)
      return status.isOpen && status.path !== firstVault
    })
    .toBe(true)

  await expectSidebar(page, 'collapsed')
})
