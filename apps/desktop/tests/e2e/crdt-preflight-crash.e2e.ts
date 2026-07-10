/**
 * CRDT preflight crash E2E — reproduces the customer's silent-death launch.
 *
 * A Windows 10 user on 2026.709.x had the main process die outright ~3s after
 * launch, before the window painted: no JS error, no uncaughtException, no
 * log line — the signature of a native abort in the classic-level binding.
 * In-process guards cannot catch a process abort, so the binding is now
 * exercised in a disposable utilityProcess first (crdt-preflight-child.ts).
 *
 * This test forces the child to die the same way (process.abort via
 * MEMRY_TEST_CRDT_PREFLIGHT_CRASH, honored only under NODE_ENV=test) and
 * asserts the app still launches a visible, working window — the CRDT layer
 * quietly degrades to in-memory mode instead of taking the app down.
 */
import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { launchElectronWithWindow, destroyElectronApp } from './utils/electron-lifecycle'

test('opens a working window even when the CRDT preflight child crashes hard', async () => {
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-preflight-vault-'))

  const launched = await launchElectronWithWindow({
    testVaultPath,
    extraEnv: { MEMRY_TEST_CRDT_PREFLIGHT_CRASH: '1' }
  })

  try {
    // The window appearing at all is the core assertion — the customer's
    // build never got this far. Then make sure it's the real app, not the
    // startup-failure recovery page.
    await expect(launched.page.locator('body')).toBeVisible()
    await expect(launched.page.locator('body')).not.toContainText("couldn't finish starting")

    // Guard against a vacuous pass: the preflight child must actually have
    // died and been reported, or this test isn't exercising the crash path.
    await expect
      .poll(() => launched.mainLogs.join('\n'), { timeout: 15_000 })
      .toContain('CRDT store failed preflight')
  } finally {
    await destroyElectronApp(launched.app, [launched.userDataDir, launched.resolvedUserDataDir])
  }
})
