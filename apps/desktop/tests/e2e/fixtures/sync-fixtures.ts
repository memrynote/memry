import {
  test as base,
  expect as playwrightExpect,
  _electron as electron,
  ElectronApplication,
  Page
} from '@playwright/test'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { waitForAppReady } from '../utils/electron-helpers'

interface LaunchResult {
  app: ElectronApplication
  userDataDir: string
  resolvedUserDataDir: string
}

function createTestVault(prefix: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  return vaultPath
}

async function launchElectronApp(
  deviceId: string,
  vaultPath: string,
  syncServerUrl: string | null
): Promise<LaunchResult> {
  const isCI = !!process.env.CI
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `memry-userdata-${deviceId}-`))
  const app = await electron.launch({
    args: [
      ...(isCI ? ['--no-sandbox', '--disable-gpu'] : []),
      `--user-data-dir=${userDataDir}`,
      path.join(__dirname, '../../../out/main/index.js')
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MEMRY_DEVICE: deviceId,
      TEST_VAULT_PATH: vaultPath,
      ...(syncServerUrl && { SYNC_SERVER_URL: syncServerUrl }),
      ...(isCI && { ELECTRON_DISABLE_SANDBOX: '1' })
    }
  })

  const resolvedUserDataDir = await app.evaluate(({ app }) => app.getPath('userData'))

  return { app, userDataDir, resolvedUserDataDir }
}

async function getReadyPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitForAppReady(page)
  return page
}

async function waitForVaultPath(page: Page, expectedVaultPath: string, timeout = 15000): Promise<void> {
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
    const { app, userDataDir, resolvedUserDataDir } = await launchElectronApp(
      deviceIdA,
      vaultPathA,
      syncServerUrl
    )
    await use(app)
    await app.close()
    cleanupDir(userDataDir)
    cleanupDir(resolvedUserDataDir)
  },

  electronAppB: async ({ deviceIdB, vaultPathB, syncServerUrl }, use) => {
    const { app, userDataDir, resolvedUserDataDir } = await launchElectronApp(
      deviceIdB,
      vaultPathB,
      syncServerUrl
    )
    await use(app)
    await app.close()
    cleanupDir(userDataDir)
    cleanupDir(resolvedUserDataDir)
  },

  pageA: async ({ electronAppA, vaultPathA }, use) => {
    const page = await getReadyPage(electronAppA)
    await waitForVaultPath(page, vaultPathA)
    await use(page)
  },

  pageB: async ({ electronAppB, vaultPathB }, use) => {
    const page = await getReadyPage(electronAppB)
    await waitForVaultPath(page, vaultPathB)
    await use(page)
  }
})

export { expect } from '@playwright/test'
