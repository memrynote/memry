import {
  test as base,
  expect as playwrightExpect,
  ElectronApplication,
  Page
} from '@playwright/test'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { waitForAppReady } from '../utils/electron-helpers'
import {
  destroyElectronApp,
  launchElectronWithWindow,
  LaunchedElectron
} from '../utils/electron-lifecycle'

function createTestVault(prefix: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  return vaultPath
}

async function waitForVaultPath(
  page: Page,
  expectedVaultPath: string,
  timeout = 15000
): Promise<void> {
  await playwrightExpect
    .poll(() => page.evaluate(() => window.api.vault.getStatus()), { timeout })
    .toMatchObject({
      isOpen: true,
      path: expectedVaultPath
    })
}

function cleanupDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true })
}

export const test = base.extend<{
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  vaultPathA: string
  vaultPathB: string
  deviceIdA: string
  deviceIdB: string
  syncServerUrl: string | null
}>({
  syncServerUrl: async ({}, use) => {
    await use(null)
  },

  deviceIdA: async ({}, use) => {
    await use(`e2e-${randomUUID()}-A`)
  },

  deviceIdB: async ({}, use) => {
    await use(`e2e-${randomUUID()}-B`)
  },

  vaultPathA: async ({}, use) => {
    const vaultPath = createTestVault('memry-e2e-deviceA-')
    await use(vaultPath)
    cleanupDir(vaultPath)
  },

  vaultPathB: async ({}, use) => {
    const vaultPath = createTestVault('memry-e2e-deviceB-')
    await use(vaultPath)
    cleanupDir(vaultPath)
  },

  electronAppA: async ({ deviceIdA, vaultPathA, syncServerUrl }, use) => {
    const launched = await launchElectronWithWindow({
      testVaultPath: vaultPathA,
      deviceId: deviceIdA,
      syncServerUrl
    })
    ;(launched.app as unknown as { __launched?: LaunchedElectron }).__launched = launched
    await use(launched.app)
    const dirs = [launched.userDataDir]
    if (launched.resolvedUserDataDir !== launched.userDataDir) {
      dirs.push(launched.resolvedUserDataDir)
    }
    await destroyElectronApp(launched.app, dirs)
  },

  electronAppB: async ({ deviceIdB, vaultPathB, syncServerUrl }, use) => {
    const launched = await launchElectronWithWindow({
      testVaultPath: vaultPathB,
      deviceId: deviceIdB,
      syncServerUrl
    })
    ;(launched.app as unknown as { __launched?: LaunchedElectron }).__launched = launched
    await use(launched.app)
    const dirs = [launched.userDataDir]
    if (launched.resolvedUserDataDir !== launched.userDataDir) {
      dirs.push(launched.resolvedUserDataDir)
    }
    await destroyElectronApp(launched.app, dirs)
  },

  pageA: async ({ electronAppA, vaultPathA }, use) => {
    const launched = (electronAppA as unknown as { __launched?: LaunchedElectron }).__launched
    const page = launched?.page ?? (await electronAppA.firstWindow({ timeout: 45_000 }))
    await waitForAppReady(page)
    await waitForVaultPath(page, vaultPathA)
    await use(page)
  },

  pageB: async ({ electronAppB, vaultPathB }, use) => {
    const launched = (electronAppB as unknown as { __launched?: LaunchedElectron }).__launched
    const page = launched?.page ?? (await electronAppB.firstWindow({ timeout: 45_000 }))
    await waitForAppReady(page)
    await waitForVaultPath(page, vaultPathB)
    await use(page)
  }
})

export { expect } from '@playwright/test'
