/**
 * Tag suggestions in a filter's value input.
 *
 * A `tags contains …` condition used to demand the tag be typed from memory:
 * the value was a bare text box with no knowledge of the vault's tags. This
 * drives the real app because the value that matters is the one that reaches
 * the query — a component test can prove the dropdown fills the input, not
 * that the table behind it narrows.
 */

import type { Locator, Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const UNIQUE = Date.now().toString(36)
const TAG_ROOT = `suggest${UNIQUE}`
const TAG_CHILD = `${TAG_ROOT}/design`

const ROOT_ONLY_TITLE = `Root only ${UNIQUE}`
const CHILD_TITLE = `Child tagged ${UNIQUE}`

async function seedNotes(page: Page): Promise<void> {
  const ok = await page.evaluate(
    async ({ root, child, rootTitle, childTitle }) => {
      const a = await window.api.notes.create({
        title: rootTitle,
        content: 'Only the root tag',
        tags: [root]
      })
      const b = await window.api.notes.create({
        title: childTitle,
        content: 'Root plus the nested tag',
        tags: [root, child]
      })
      return !!a?.success && !!b?.success
    },
    { root: TAG_ROOT, child: TAG_CHILD, rootTitle: ROOT_ONLY_TITLE, childTitle: CHILD_TITLE }
  )
  expect(ok).toBeTruthy()
}

async function openTagPage(page: Page, tag: string): Promise<void> {
  const trigger = page.locator('button[aria-label^="Tags section, "]')
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  if (((await trigger.getAttribute('aria-label')) ?? '').includes('collapsed')) {
    await trigger.click()
  }
  const tagRow = page.getByRole('button', { name: tag, exact: true }).first()
  await tagRow.waitFor({ state: 'visible', timeout: 20_000 })
  await tagRow.click()
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
}

/** Open the filter popover and add an empty `tags contains` condition. */
async function addTagsCondition(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Filter', exact: true }).first().click()
  // Pinned by content, not by order: the suggestion list is its own popper,
  // so `.last()` stops being the filter popover the moment it opens.
  const popover = page
    .locator('[data-radix-popper-content-wrapper]')
    .filter({ has: page.getByRole('button', { name: 'Add filter' }) })
  await popover.getByRole('button', { name: 'Add filter' }).click()

  await popover.getByRole('combobox', { name: 'Property' }).click()
  await page.getByRole('option', { name: 'Tags' }).click()

  // `tags` is a multiselect, whose default operator is already `contains`.
  await expect(popover.getByRole('combobox', { name: 'Operator' })).toContainText('contains')
  return popover
}

const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

test.describe('Tag value suggestions in the filter builder', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('focus offers vault tags, typing re-ranks, and Enter narrows the table', async ({
    page
  }) => {
    await seedNotes(page)
    await openTagPage(page, TAG_ROOT)

    await expect(rows(page).filter({ hasText: ROOT_ONLY_TITLE })).toHaveCount(1)
    await expect(rows(page).filter({ hasText: CHILD_TITLE })).toHaveCount(1)

    const popover = await addTagsCondition(page)
    const value = popover.getByRole('combobox', { name: 'Value' })
    await value.click()

    // Focus alone is enough — nothing typed yet.
    const list = page.getByRole('listbox', { name: 'Tag suggestions' })
    await expect(list).toBeVisible({ timeout: 10_000 })

    // Every keystroke re-ranks: "design" is only the nested tag's leaf.
    await value.fill('design')
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(list.getByRole('option').first()).toContainText(TAG_CHILD)

    // Arrow + Enter commits the tag into the value, and the list closes.
    await value.press('ArrowDown')
    await value.press('Enter')
    await expect(value).toHaveValue(TAG_CHILD)
    await expect(list).toBeHidden()

    // The filter behind it ran: only the note carrying the nested tag is left.
    await page.keyboard.press('Escape')
    await expect(rows(page).filter({ hasText: CHILD_TITLE })).toHaveCount(1, { timeout: 15_000 })
    await expect(rows(page).filter({ hasText: ROOT_ONLY_TITLE })).toHaveCount(0)
  })
})
