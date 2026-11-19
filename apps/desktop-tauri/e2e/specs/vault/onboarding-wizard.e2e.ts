// The first-run wizard on a fresh profile (Step 32i1, #3549): Obsidian's vaults come from the
// detection command, the new-user path ends on Home with the folder, the metrics choice and the
// onboarding record stored, and a relaunch opens the vault without the wizard or the tour.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import { invoke, vaultStatus } from '../../harness/vault-commands'

// Stands in for the OS app data and app folders, so the run never lists the host's Obsidian
// vaults or apps.
const osAppData = mkdtempSync(join(tmpdir(), 'memry-e2e-os-appdata-'))
const obsidianVault = join(osAppData, 'Research')
mkdirSync(join(osAppData, 'obsidian'), { recursive: true })
mkdirSync(obsidianVault)
writeFileSync(
  join(osAppData, 'obsidian', 'obsidian.json'),
  JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: obsidianVault, ts: 1 } } })
)

const parent = mkdtempSync(join(tmpdir(), 'memry-e2e-wizard-'))

test.use({
  firstRun: true,
  extraEnv: {
    MEMRY_TEST_OS_APP_DATA_DIR: osAppData,
    MEMRY_TEST_OS_APPS_DIR: join(osAppData, 'Applications')
  }
})

test.afterAll(() => {
  rmSync(osAppData, { recursive: true, force: true })
  rmSync(parent, { recursive: true, force: true })
})

test('a new user goes through the wizard to Home, and a relaunch skips it', async ({
  app,
  page
}) => {
  const vaultPath = join(parent, 'My notes')

  // A fresh profile follows the OS language; the spec reads the English strings.
  await expect
    .poll(() => page.evaluate(() => typeof window.__TAURI__?.core?.invoke), { timeout: 30_000 })
    .toBe('function')
  await invoke(page, 'locale_set', { locale: 'en' })
  await page.getByRole('button', { name: /Get started/ }).click({ timeout: 30_000 })
  await page
    .getByRole('button', { name: /Continue/ })
    .first()
    .click() // theme
  // AI off: no agent step, and no model download on the way out of it.
  await page.getByRole('checkbox', { name: /AI and agent/ }).click()
  await page
    .getByRole('button', { name: /Continue/ })
    .first()
    .click() // modules

  await expect(page.getByText(obsidianVault)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Skip, import later/ }).click()

  await expect(page.getByText('Where should your notes live?')).toBeVisible()
  await page
    .getByRole('button', { name: /Continue/ })
    .first()
    .click() // storage: this device

  await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'OpenFolder', paths: [parent] })
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await expect(page.getByText(vaultPath)).toBeVisible()
  await page.getByRole('switch', { name: 'Share anonymous usage metrics' }).click()
  await page.getByRole('button', { name: /Open MemryNote/ }).click()

  await expect
    .poll(async () => vaultStatus(page), { timeout: 45_000 })
    .toMatchObject({ isOpen: true, path: vaultPath })
  await expect(page.getByText('Your space is ready')).toBeHidden({ timeout: 15_000 })

  const stored = async () => ({
    telemetry: (await invoke<{ enabled: boolean }>(page, 'telemetry_get_settings')).enabled,
    onboarded: (
      await invoke<{ onboardingCompleted?: boolean }>(page, 'settings_get_group', {
        group: 'general'
      })
    ).onboardingCompleted,
    tour: await page.evaluate(() => localStorage.getItem('memry:onboarding:tour:v1')),
    aiModule: (await invoke<{ enabled: boolean }>(page, 'settings_get_ai')).enabled
  })
  expect(await stored()).toEqual({ telemetry: false, onboarded: true, tour: '1', aiModule: false })
  // The wizard stands in for the sidebar tour.
  await expect(page.locator('.driver-popover')).toHaveCount(0)

  await restart(app)
  await expect
    .poll(async () => vaultStatus(page), { timeout: 45_000 })
    .toMatchObject({ isOpen: true, path: vaultPath })
  await expect(page.getByRole('button', { name: /Get started/ })).toHaveCount(0)
  await expect(page.locator('.driver-popover')).toHaveCount(0)
  expect(await stored()).toEqual({ telemetry: false, onboarded: true, tour: '1', aiModule: false })
})
