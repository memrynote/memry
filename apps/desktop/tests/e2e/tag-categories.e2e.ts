/**
 * Tag categories E2E
 *
 * Covers the two user-visible flows the feature adds:
 *  1. Clicking a tag anywhere in the sidebar opens the single-tag page (a
 *     tab per tag) with a table of the tag's items — replacing the old
 *     sidebar drill-down (removed in Task 20, `tag-detail-view.tsx`).
 *  2. A category created in the tag hub is real, persisted data (the
 *     `tag_categories` table), not renderer-only state — it must survive an
 *     app restart against the same vault.
 *
 * The restart case can't use the shared single-launch `fixtures.ts` (it
 * launches once per test), so it drives `launchElectronWithWindow` /
 * `destroyElectronApp` directly against the same `testVaultPath` twice, the
 * same pattern `diagnostics-report.e2e.ts` and `vault-deletion.e2e.ts` use
 * for custom launch control. `TEST_VAULT_PATH` auto-opens that vault on
 * each launch (see `vault/index.ts`), so the second launch reopens the
 * exact same data/index DBs without going through onboarding again.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS, waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'

const UNIQUE = Date.now().toString(36)
const TAG = `meetings${UNIQUE}`

async function seedNoteWithTag(page: Page, tag: string): Promise<void> {
  const created = await page.evaluate(async (tagName) => {
    const res = await window.api.notes.create({
      title: `Tag Category Test ${tagName}`,
      content: `Note body with #${tagName}`,
      tags: [tagName]
    })
    return !!res?.success
  }, tag)
  expect(created).toBeTruthy()
}

async function expandTagsSection(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Tags section, "]')
  await trigger.waitFor({ state: 'visible', timeout: 10000 })
  const label = (await trigger.getAttribute('aria-label')) ?? ''
  if (label.includes('collapsed')) {
    await trigger.click()
    await page.locator('button[aria-label^="Tags section, expanded"]').waitFor({
      state: 'visible',
      timeout: 5000
    })
  }
}

async function openTagHub(page: Page): Promise<void> {
  await page.locator('button[aria-label="Open tag hub"]').click()
  await page
    .getByRole('button', { name: /new category/i })
    .waitFor({ state: 'visible', timeout: 10000 })
}

test.describe('Tag categories', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('clicking a sidebar tag opens a tag tab with its items', async ({ page }) => {
    await seedNoteWithTag(page, TAG)
    await expandTagsSection(page)

    const tagButton = page.getByRole('button', { name: TAG, exact: true }).first()
    await tagButton.waitFor({ state: 'visible', timeout: 15000 })
    await tagButton.click()

    const activeTab = page.locator(SELECTORS.activeTab).first()
    await expect(activeTab).toBeVisible({ timeout: 10000 })
    await expect(activeTab).toContainText(TAG)
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10000 })
  })
})

// The restart case launches/destroys Electron directly (see file header) so
// it is a standalone test, not part of the `fixtures.ts` describe block above.
test('a category created in the hub persists across a restart', async () => {
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tag-categories-vault-'))
  fs.mkdirSync(path.join(testVaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(testVaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(testVaultPath, 'journal'), { recursive: true })

  const restartCategory = `Restart ${UNIQUE}`

  const first = await launchElectronWithWindow({ testVaultPath })
  try {
    await waitForAppReady(first.page)
    await waitForVaultReady(first.page)

    await openTagHub(first.page)
    await first.page.getByRole('button', { name: /new category/i }).click()
    await first.page.getByRole('textbox', { name: 'Category name' }).fill(restartCategory)
    await first.page.keyboard.press('Enter')

    await expect(first.page.getByText(restartCategory)).toBeVisible({ timeout: 10000 })
  } finally {
    await destroyElectronApp(
      first.app,
      [first.userDataDir, first.resolvedUserDataDir],
      first.deviceId
    )
  }

  const second = await launchElectronWithWindow({ testVaultPath })
  try {
    await waitForAppReady(second.page)
    await waitForVaultReady(second.page)

    await openTagHub(second.page)
    await expect(second.page.getByText(restartCategory)).toBeVisible({ timeout: 15000 })
  } finally {
    await destroyElectronApp(
      second.app,
      [second.userDataDir, second.resolvedUserDataDir],
      second.deviceId
    )
    fs.rmSync(testVaultPath, { recursive: true, force: true })
  }
})
