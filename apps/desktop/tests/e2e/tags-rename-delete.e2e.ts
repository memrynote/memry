// @ts-nocheck
/**
 * Tags Rename + Delete E2E
 *
 * Covers the sidebar tag detail view's overflow menu flows:
 *  - Rename dialog: input prefilled, save calls rename, sidebar refreshes.
 *  - Delete dialog: confirmation, tag removed from sidebar after confirm.
 *
 * Plan ref: .claude/plans/tech-debt-remediation.md § 5.2
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, SELECTORS } from './utils/electron-helpers'

const UNIQUE = Date.now().toString(36)
const TAG = `renamecandidate${UNIQUE}`
const RENAMED = `renamed${UNIQUE}`

async function seedNoteWithTag(page, tag: string): Promise<void> {
  const created = await page.evaluate(async (tagName) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    if (!api?.notes?.create) return false
    const res = await api.notes.create({
      title: `Tag Test ${tagName}`,
      content: `Note body with #${tagName}`,
      tags: [tagName]
    })
    return !!res?.success
  }, tag)
  expect(created).toBeTruthy()
}

async function expandTagsSection(page): Promise<void> {
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

async function openTagDrilldown(page, tag: string): Promise<void> {
  await expandTagsSection(page)
  const tagTrigger = page.getByRole('button', { name: tag, exact: true }).first()
  await tagTrigger.waitFor({ state: 'visible', timeout: 15000 })
  await tagTrigger.click()
  await page.locator('button[aria-label="Go back"]').waitFor({ state: 'visible', timeout: 10000 })
}

test.describe('Tag rename + delete (§5.2)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('renames a tag via overflow menu', async ({ page }) => {
    await seedNoteWithTag(page, TAG)
    await openTagDrilldown(page, TAG)

    await page.locator('button[aria-label="Tag actions"]').click()
    await page.locator('text=Edit tag name').click()

    const input = page.locator('#tag-rename-input')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue(TAG)

    await input.fill(RENAMED)
    await page.locator('button', { hasText: 'Save' }).click()

    // After success we auto-navigate back; sidebar should show renamed tag
    await expandTagsSection(page)
    await expect(page.getByRole('button', { name: RENAMED, exact: true }).first()).toBeVisible({
      timeout: 10000
    })
    await expect(page.getByRole('button', { name: TAG, exact: true })).toHaveCount(0)
  })

  test('deletes a tag via overflow menu', async ({ page }) => {
    const deleteTag = `deletecandidate${UNIQUE}`
    await seedNoteWithTag(page, deleteTag)
    await openTagDrilldown(page, deleteTag)

    await page.locator('button[aria-label="Tag actions"]').click()
    await page.locator('text=Delete tag').first().click()

    // Confirmation dialog
    await expect(page.locator(`text=Delete tag #${deleteTag}?`)).toBeVisible()
    // Click the destructive confirm — matches the "Delete tag" button in the dialog
    await page.locator('[role="alertdialog"] button', { hasText: 'Delete tag' }).click()

    await expandTagsSection(page)
    await expect(page.getByRole('button', { name: deleteTag, exact: true })).toHaveCount(0, {
      timeout: 10000
    })
  })
})

// Keep referenced so unused-imports linters stay quiet if SELECTORS evolves.
void SELECTORS
