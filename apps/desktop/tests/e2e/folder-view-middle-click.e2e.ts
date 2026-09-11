/**
 * Middle-click on a folder-view / tag-page row.
 *
 * The sidebar rows have opened in a background tab on middle click for a
 * while; the table these pages render did not, so the gesture died on the
 * biggest list in the app. Driven against the real app because the whole
 * claim is about the tab strip, which only the tab system can answer.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const UNIQUE = Date.now().toString(36)
const TAG = `middle${UNIQUE}`
const FOLDER = `Middle${UNIQUE}`

const TAGGED_TITLE = `Tagged row ${UNIQUE}`
const FOLDER_TITLE = `Folder row ${UNIQUE}`

const tabs = (page: Page) => page.locator(SELECTORS.tab)
const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

async function seedNotes(page: Page): Promise<void> {
  const ok = await page.evaluate(
    async ({ tag, folder, taggedTitle, folderTitle }) => {
      const tagged = await window.api.notes.create({
        title: taggedTitle,
        content: 'Lives on the tag page',
        tags: [tag]
      })
      const inFolder = await window.api.notes.create({
        title: folderTitle,
        content: 'Lives in a folder',
        folder
      })
      return !!tagged?.success && !!inFolder?.success
    },
    { tag: TAG, folder: FOLDER, taggedTitle: TAGGED_TITLE, folderTitle: FOLDER_TITLE }
  )
  expect(ok).toBeTruthy()
}

async function expandSection(page: Page, prefix: string): Promise<void> {
  const trigger = page.locator(`button[aria-label^="${prefix} section, "]`)
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  if (((await trigger.getAttribute('aria-label')) ?? '').includes('collapsed')) {
    await trigger.click()
  }
}

/** Middle-click the row carrying `title` and assert a background tab arrived. */
async function expectBackgroundOpen(page: Page, title: string, activeText: string): Promise<void> {
  const before = await tabs(page).count()
  await rows(page).filter({ hasText: title }).first().click({ button: 'middle' })

  await expect.poll(async () => tabs(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await expect(page.locator(SELECTORS.tab).filter({ hasText: title }).first()).toBeVisible()
  // Background: the page we middle-clicked from keeps focus.
  await expect(page.locator(SELECTORS.activeTab)).toContainText(activeText)
}

test.describe('Middle-click opens a row in a background tab', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
    await seedNotes(page)
  })

  test('on a tag page', async ({ page }) => {
    await expandSection(page, 'Tags')
    await page.getByRole('button', { name: TAG, exact: true }).first().click()
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })

    await expectBackgroundOpen(page, TAGGED_TITLE, TAG)
  })

  test('on a folder view page', async ({ page }) => {
    await expandSection(page, 'Collections')
    const folderRow = page.locator(`[data-tree-node-id="folder-${FOLDER}"]`)
    await folderRow.waitFor({ state: 'visible', timeout: 20_000 })
    // A plain click on a folder row only expands it; the folder *view* has its
    // own affordance on the row.
    await folderRow.hover()
    await folderRow.getByRole('button', { name: 'Open folder view' }).click()
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })

    await expectBackgroundOpen(page, FOLDER_TITLE, FOLDER)
  })
})
