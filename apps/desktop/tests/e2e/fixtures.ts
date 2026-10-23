/**
 * Playwright fixtures for single-device Electron E2E tests.
 *
 * Delegates launch + teardown to utils/electron-lifecycle.ts, which provides
 * bounded shutdown, SIGKILL fallback, and first-window retry.
 */

import type { ElectronApplication, Page } from '@playwright/test'
import { test as base } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { LaunchedElectron } from './utils/electron-lifecycle'
import { destroyLaunchedElectron, launchElectronWithWindow } from './utils/electron-lifecycle'

export const test = base.extend<{
  electronApp: ElectronApplication
  page: Page
  testVaultPath: string
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring, so a fixture with none still needs it
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

    await destroyLaunchedElectron(launched)
  },

  page: async ({ electronApp }, use) => {
    const launched = (electronApp as unknown as { __launched?: LaunchedElectron }).__launched
    const page = launched?.page ?? (await electronApp.firstWindow({ timeout: 45_000 }))
    await use(page)
  }
})

export { expect } from '@playwright/test'
