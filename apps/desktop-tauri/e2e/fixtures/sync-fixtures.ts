// Two-instance fixtures, the port of tests/e2e/fixtures/sync-fixtures.ts. Instance A is
// `app`/`page`/`testVaultPath` and instance B is `appB`/`pageB`/`vaultPathB` (run with
// `test:e2e:multi`). Both vaults start empty, as in the Electron suite.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { waitForAppReady } from '../harness/app-helpers'
import { expect } from '../harness/pw-compat/expect'
import type { Page } from '../harness/pw-compat/page'
import { test as base } from '../harness/test'

function createTestVault(prefix: string): string {
  const vaultPath = mkdtempSync(join(tmpdir(), prefix))
  for (const dir of ['.memry', 'notes', 'journal'])
    mkdirSync(join(vaultPath, dir), { recursive: true })
  return vaultPath
}

async function waitForVaultPath(
  page: Page,
  expectedVaultPath: string,
  timeout = 15000
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.api.vault.getStatus()), { timeout })
    .toMatchObject({ isOpen: true, path: expectedVaultPath })
}

export const test = base.extend<{
  testVaultPath: string
  vaultPathB: string
  page: Page
  pageB: Page
}>({
  testVaultPath: async ({}, use) => {
    const vaultPath = createTestVault('memry-e2e-deviceA-')
    await use(vaultPath)
    rmSync(vaultPath, { recursive: true, force: true })
  },

  vaultPathB: async ({}, use) => {
    const vaultPath = createTestVault('memry-e2e-deviceB-')
    await use(vaultPath)
    rmSync(vaultPath, { recursive: true, force: true })
  },

  page: async ({ page, testVaultPath }, use) => {
    await waitForAppReady(page)
    await waitForVaultPath(page, testVaultPath)
    await use(page)
  },

  pageB: async ({ pageB, vaultPathB }, use) => {
    await waitForAppReady(pageB)
    await waitForVaultPath(pageB, vaultPathB)
    await use(pageB)
  }
})

export { expect }
