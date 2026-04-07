/**
 * Playwright fixtures for Electron testing.
 */

import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Extend base test with Electron fixtures
export const test = base.extend<{
  electronApp: ElectronApplication
  page: Page
  testVaultPath: string
}>({
  // Create a test vault for each test
  testVaultPath: async ({}, use) => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-'))

    // Initialize vault structure
    fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })

    await use(vaultPath)

    // Cleanup
    fs.rmSync(vaultPath, { recursive: true, force: true })
  },

  // Launch Electron application
  electronApp: async ({ testVaultPath }, use) => {
    const isCI = !!process.env.CI
    // Per-test user-data-dir keeps Chromium state (cookies, localStorage,
    // GPU caches) isolated. Without this, Electron's shared
    // `Application Support/Electron` dir can hold corrupted state from
    // previous runs (e.g. an `[object Object]` theme value that crashes
    // next-themes during renderer init), causing every test to fail.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-userdata-'))
    const app = await electron.launch({
      args: [
        ...(isCI ? ['--no-sandbox', '--disable-gpu'] : []),
        `--user-data-dir=${userDataDir}`,
        path.join(__dirname, '../../out/main/index.js')
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_VAULT_PATH: testVaultPath,
        ...(isCI && { ELECTRON_DISABLE_SANDBOX: '1' })
      }
    })

    await use(app)

    await app.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  },

  // Get the main window page
  page: async ({ electronApp }, use) => {
    // Wait for the first window
    const page = await electronApp.firstWindow()

    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded')

    await use(page)
  }
})

export { expect } from '@playwright/test'
