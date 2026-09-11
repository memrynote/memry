/**
 * Multi-tag (AND) selection E2E — issue #2078.
 *
 * Covers the two flows the feature adds on top of the existing single-tag
 * page:
 *  1. Ctrl/Cmd-clicking a second sidebar tag narrows the open tag page to
 *     items carrying BOTH tags, without navigating away, and clearing the
 *     selection restores the single-tag result.
 *  2. A named saved search is real, persisted vault settings — it must
 *     survive an app restart and reopen the same AND filter.
 *
 * The restart case cannot use the shared single-launch `fixtures.ts`, so it
 * drives `launchElectronWithWindow` directly against the same
 * `testVaultPath` twice — the same pattern as `tag-categories.e2e.ts`.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'

const UNIQUE = Date.now().toString(36)
const TAG_A = `alpha${UNIQUE}`
const TAG_B = `beta${UNIQUE}`

const BOTH_TITLE = `Both ${UNIQUE}`
const ONLY_A_TITLE = `Only alpha ${UNIQUE}`

async function seedNotes(page: Page): Promise<void> {
  const ok = await page.evaluate(
    async ({ tagA, tagB, bothTitle, onlyATitle }) => {
      const both = await window.api.notes.create({
        title: bothTitle,
        content: 'Carries both tags',
        tags: [tagA, tagB]
      })
      const onlyA = await window.api.notes.create({
        title: onlyATitle,
        content: 'Carries only the first tag',
        tags: [tagA]
      })
      return !!both?.success && !!onlyA?.success
    },
    { tagA: TAG_A, tagB: TAG_B, bothTitle: BOTH_TITLE, onlyATitle: ONLY_A_TITLE }
  )
  expect(ok).toBeTruthy()
}

async function expandTagsSection(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Tags section, "]')
  await trigger.waitFor({ state: 'visible', timeout: 10000 })
  const label = (await trigger.getAttribute('aria-label')) ?? ''
  if (label.includes('collapsed')) {
    await trigger.click()
    await page
      .locator('button[aria-label^="Tags section, expanded"]')
      .waitFor({ state: 'visible', timeout: 5000 })
  }
}

async function clickSidebarTag(page: Page, tag: string, additive = false): Promise<void> {
  const button = page.getByRole('button', { name: tag, exact: true }).first()
  await button.waitFor({ state: 'visible', timeout: 15000 })
  // `ControlOrMeta` is Playwright's platform-correct Cmd (macOS) / Ctrl
  // (Windows, Linux) modifier — exactly the gesture the issue asks for.
  await button.click(additive ? { modifiers: ['ControlOrMeta'] } : undefined)
}

const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

test.describe('Multi-tag AND selection', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('Ctrl/Cmd-click ANDs a second tag, and clear-all restores the single tag', async ({
    page
  }) => {
    await seedNotes(page)
    await expandTagsSection(page)

    await clickSidebarTag(page, TAG_A)
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15000 })
    await expect(rows(page).filter({ hasText: BOTH_TITLE })).toHaveCount(1)
    await expect(rows(page).filter({ hasText: ONLY_A_TITLE })).toHaveCount(1)

    await clickSidebarTag(page, TAG_B, true)

    // Still the same tag tab — the additive click must not navigate.
    const bar = page.getByTestId('tag-and-filter-bar')
    await expect(bar).toBeVisible({ timeout: 10000 })
    await expect(bar).toContainText(TAG_B)
    await expect(rows(page).filter({ hasText: ONLY_A_TITLE })).toHaveCount(0)
    await expect(rows(page).filter({ hasText: BOTH_TITLE })).toHaveCount(1)

    await page.getByTestId('tag-and-filter-clear').click()
    await expect(rows(page).filter({ hasText: ONLY_A_TITLE })).toHaveCount(1)
    await expect(rows(page).filter({ hasText: BOTH_TITLE })).toHaveCount(1)
  })
})

// Restart case: launches/destroys Electron directly (see file header).
test('a saved multi-tag search reopens the same AND filter after a restart', async () => {
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tag-multi-select-vault-'))
  fs.mkdirSync(path.join(testVaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(testVaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(testVaultPath, 'journal'), { recursive: true })

  const searchName = `Saved ${UNIQUE}`

  const first = await launchElectronWithWindow({ testVaultPath })
  try {
    await ready(first.page)
    await seedNotes(first.page)
    await expandTagsSection(first.page)

    await clickSidebarTag(first.page, TAG_A)
    await expect(first.page.getByRole('table')).toBeVisible({ timeout: 15000 })
    await clickSidebarTag(first.page, TAG_B, true)
    await expect(first.page.getByTestId('tag-and-filter-bar')).toBeVisible({ timeout: 10000 })

    await first.page.getByTestId('tag-and-filter-save').click()
    await first.page.getByTestId('tag-and-filter-save-name').fill(searchName)
    await first.page.getByTestId('tag-and-filter-save-confirm').click()

    await expect(first.page.getByTestId('tag-and-filter-saved-menu')).toBeVisible({
      timeout: 10000
    })
  } finally {
    await destroyElectronApp(
      first.app,
      [first.userDataDir, first.resolvedUserDataDir],
      first.deviceId
    )
  }

  const second = await launchElectronWithWindow({ testVaultPath })
  try {
    await ready(second.page)
    await expandTagsSection(second.page)

    // A plain click: the page opens unfiltered, exactly as before the feature.
    await clickSidebarTag(second.page, TAG_A)
    await expect(second.page.getByRole('table')).toBeVisible({ timeout: 15000 })
    await expect(rows(second.page).filter({ hasText: ONLY_A_TITLE })).toHaveCount(1)

    await second.page.getByTestId('tag-and-filter-saved-menu').click()
    await second.page.getByRole('menuitem', { name: new RegExp(searchName) }).click()

    await expect(rows(second.page).filter({ hasText: ONLY_A_TITLE })).toHaveCount(0)
    await expect(rows(second.page).filter({ hasText: BOTH_TITLE })).toHaveCount(1)
  } finally {
    await destroyElectronApp(
      second.app,
      [second.userDataDir, second.resolvedUserDataDir],
      second.deviceId
    )
    fs.rmSync(testVaultPath, { recursive: true, force: true })
  }
})
