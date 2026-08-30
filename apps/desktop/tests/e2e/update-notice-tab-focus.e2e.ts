import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const SURFACED_VERSION = '2026.999.9'

/**
 * Broadcast a surfaced release from main on the channel the renderer's updater
 * store already listens to. `downloading` is the silent auto-download phase, which
 * is deliberately not promptable, so no modal opens over the app and the
 * release-notes tab is the only thing the update flow puts on screen.
 */
async function surfaceUpdate(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, version) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('updater:state-changed', {
      currentVersion: '2026.700.1',
      status: 'downloading',
      updateSupported: true,
      availableVersion: version,
      releaseName: `MemryNote ${version}`,
      releaseDate: null,
      releaseNotes: 'notes',
      releaseNotesHtml: `<h2>Fixes</h2><p>Release ${version}</p>`,
      downloadProgressPercent: 10,
      lastCheckedAt: null,
      error: null,
      autoDownloadEnabled: true,
      autoCheckEnabled: true
    })
  }, SURFACED_VERSION)
}

/** `templates.get` resolves the template itself, not a `{ template }` envelope. */
async function persistedBody(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (templateName) => {
    const list = await window.api.templates.list()
    const match = list.templates.find((template) => template.name === templateName)
    if (!match) return null
    const full = await window.api.templates.get(match.id)
    return full?.content ?? null
  }, name)
}

test.describe('Update notice tab focus', () => {
  test('a surfaced release does not steal focus from, or discard, a template being written', async ({
    page,
    electronApp
  }) => {
    await ready(page)

    const templateName = uniqueLabel('Weekly Review')

    await page.evaluate(() => {
      window.api.quickCapture.openSettings('templates')
    })
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'New Template' }).click()

    // The title field only commits on blur, so Enter is what actually sets the
    // name and enables Create.
    await page.getByPlaceholder('Template name').fill(templateName)
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Create Template' }).click()

    const editor = page.locator(SELECTORS.noteEditor).first()
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await editor.click()
    await page.keyboard.type('Wins and blockers')

    // Surface the release straight after typing, while the body is still inside
    // the debounce window that the focus steal used to destroy.
    await surfaceUpdate(electronApp)

    const releaseNotesTab = page.getByRole('tab', { name: `MemryNote ${SURFACED_VERSION}` })
    await expect(releaseNotesTab).toBeVisible({ timeout: 20_000 })
    await expect(releaseNotesTab).toHaveAttribute('aria-selected', 'false')
    await expect(page.locator(SELECTORS.activeTab)).toHaveAttribute('aria-label', templateName)

    // Past the editor's 150ms markdown debounce and the template's 800ms save.
    await page.waitForTimeout(4_000)
    expect(await persistedBody(page, templateName)).toContain('Wins and blockers')
  })
})
