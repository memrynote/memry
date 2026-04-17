/**
 * Playwright fixtures for single-device Electron E2E tests.
 *
 * Delegates launch + teardown to utils/electron-lifecycle.ts, which provides
 * bounded shutdown, SIGKILL fallback, and first-window retry.
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  destroyElectronApp,
  launchElectronWithWindow,
  LaunchedElectron
} from './utils/electron-lifecycle'

export const test = base.extend<{
  electronApp: ElectronApplication
  page: Page
  testVaultPath: string
}>({
  testVaultPath: async ({}, use) => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-'))

    fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })

    await use(vaultPath)

    fs.rmSync(vaultPath, { recursive: true, force: true })
  },

  electronApp: async ({ testVaultPath }, use) => {
    const launched = await launchElectronWithWindow({ testVaultPath })

    ;(launched.app as unknown as { __launched?: LaunchedElectron }).__launched = launched

    await use(launched.app)

    const dirs = [launched.userDataDir]
    if (launched.resolvedUserDataDir !== launched.userDataDir) {
      dirs.push(launched.resolvedUserDataDir)
    }
    await destroyElectronApp(launched.app, dirs)
  },

  page: async ({ electronApp }, use) => {
    const launched = (electronApp as unknown as { __launched?: LaunchedElectron }).__launched
    const page = launched?.page ?? (await electronApp.firstWindow({ timeout: 45_000 }))
    await use(page)
  }
})

export { expect } from '@playwright/test'
