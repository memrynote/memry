/**
 * Startup recovery E2E — reproduces the customer's "app won't open" report.
 *
 * A Windows 10 user hit a startup that failed BEFORE the main window was created
 * (ENOSPC on a full disk / GPU crash on old hardware). The process stayed alive
 * with no window and no taskbar entry — an invisible zombie holding the
 * single-instance lock, so every relaunch was a silent no-op.
 *
 * This test forces that exact failure (MEMRY_TEST_FORCE_STARTUP_THROW, honored
 * only under NODE_ENV=test) and asserts the app still surfaces a VISIBLE recovery
 * window instead of nothing.
 *
 * Expected today (no fix): no window is ever created, launchElectronWithWindow
 * times out waiting for the first window, and this test is RED — that red IS the
 * customer's bug. The whenReady .catch fix turns it GREEN.
 */
import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { launchElectronWithWindow, destroyElectronApp } from './utils/electron-lifecycle'

test('surfaces a recovery window when startup fails before the main window is created', async () => {
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-recovery-vault-'))

  // Throws (first-window timeout) today because no window is ever created —
  // that failure is the reproduction. With the fix, the recovery window paints
  // and this resolves.
  const launched = await launchElectronWithWindow({
    testVaultPath,
    extraEnv: { MEMRY_TEST_FORCE_STARTUP_THROW: '1' }
  })

  try {
    await expect(launched.page.locator('body')).toContainText("couldn't finish starting")
  } finally {
    await destroyElectronApp(launched.app, [launched.userDataDir, launched.resolvedUserDataDir])
  }
})
