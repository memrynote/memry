import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  dismissFirstRunOnboarding,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'

async function openGeneralSettings(
  page: Page,
  electronApp: ElectronApplication,
  expectedLanguageLabel = 'Language'
): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)

  const languageLabel = page.getByText(expectedLanguageLabel, { exact: true })
  const deadline = Date.now() + 15000

  while (Date.now() < deadline) {
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('settings:openSection', 'general')
    })

    if (await languageLabel.isVisible({ timeout: 500 }).catch(() => false)) return
  }

  await expect(languageLabel).toBeVisible()
}

async function chooseLanguage(page: Page, nativeName: string): Promise<void> {
  await page.locator('#language-select').click()
  await page.getByRole('option', { name: nativeName }).click()
}

test.describe('i18n', () => {
  test('switches language live', async ({ electronApp, page }) => {
    await openGeneralSettings(page, electronApp)

    await chooseLanguage(page, 'Türkçe')

    await expect(page.getByText('Dil', { exact: true })).toBeVisible()
    await expect(page.getByText(/Dil .* olarak değiştirildi/)).toBeVisible()
  })

  test('applies RTL document attributes for Arabic', async ({ electronApp, page }) => {
    await openGeneralSettings(page, electronApp)

    await chooseLanguage(page, 'العربية')

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
    await expect(page.getByText('اللغة', { exact: true })).toBeVisible()

    const labelBox = await page.getByText('اللغة', { exact: true }).boundingBox()
    const triggerBox = await page.locator('#language-select').boundingBox()

    expect(labelBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()

    const separatedHorizontally =
      triggerBox!.x + triggerBox!.width <= labelBox!.x ||
      labelBox!.x + labelBox!.width <= triggerBox!.x
    expect(separatedHorizontally).toBe(true)
  })

  test('rebuilds native menu in new language', async ({ electronApp, page }) => {
    await openGeneralSettings(page, electronApp)

    await chooseLanguage(page, 'Türkçe')
    await expect(page.getByText('Dil', { exact: true })).toBeVisible()

    const menuLabels = await electronApp.evaluate(({ Menu }) => {
      return Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
    })

    expect(menuLabels).toContain('Dosya')
  })

  test('flips a migrated common-namespace string after switching', async ({
    electronApp,
    page
  }) => {
    await openGeneralSettings(page, electronApp)

    await chooseLanguage(page, 'Türkçe')
    await expect(page.getByText('Dil', { exact: true })).toBeVisible()

    // Close Settings so the app shell's accessibility tree is queryable again.
    // (Radix dialog applies aria-hidden to siblings while open, hiding the
    // WindowControls Search button from getByRole.)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)

    // Phase B assertion: WindowControls' search button uses
    // aria-label={t('action.search')} from common.json. Turkish maps to "Ara".
    await expect(page.getByRole('button', { name: 'Ara', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0)
  })

  test('toasts surface renders post locale switch (Phase G burn-down)', async ({
    electronApp,
    page
  }) => {
    // Phase G migrated ~90 toast strings (use-undo, use-bulk-actions,
    // use-undoable-task-actions, use-drag-handlers, use-note-reminders,
    // version-history, export-dialog, sync-context, note page, etc.) plus
    // ~20 JSX state ternaries to t() calls against common/notes/tasks/
    // settings namespaces. Triggering each migrated path from e2e is
    // impractical, but they all share the same Sonner toast surface and
    // the same i18next runtime — so verifying that the toast container
    // resolves the active locale post-switch covers the wiring those
    // migrations depend on. The language-change confirmation toast fires
    // through the exact same path as every Phase G migration.
    await openGeneralSettings(page, electronApp)

    await chooseLanguage(page, 'Türkçe')

    const sonnerToast = page.locator('[data-sonner-toast]').first()
    await expect(sonnerToast).toBeVisible({ timeout: 3000 })
    await expect(page.getByText(/Dil .* olarak değiştirildi/)).toBeVisible()
  })
})
