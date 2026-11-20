// Tag suggestions in a filter's value input (#4362), ported from Electron's
// `tag-filter-suggestions.e2e.ts` (Step 30b, #3547). It drives the real app because the value
// that matters is the one that reaches the table: a `tags contains` condition picked from the
// suggestions narrows the tag page's rows, which the folder view commands list.
import type { Page } from '../../harness/pw-compat/page'
import { openTagTab, seedNote, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

/** Opens the filter popover and adds an empty `tags contains` condition. */
async function addTagsCondition(page: Page) {
  await page.getByRole('button', { name: 'Filter', exact: true }).first().click()
  // Pinned by content, not by order: the suggestion list is its own popper.
  const popover = page
    .locator('[data-radix-popper-content-wrapper]')
    .filter({ hasText: 'Add filter' })
  await popover.getByRole('button', { name: 'Add filter' }).click()
  await popover.getByRole('combobox', { name: 'Property' }).click()
  await page.getByRole('option', { name: 'Tags' }).click()
  // `tags` is a multiselect, whose default operator is already `contains`.
  await expect(popover.getByRole('combobox', { name: 'Operator' })).toContainText('contains')
  return popover
}

test('focus offers vault tags, typing re-ranks, and Enter narrows the table', async ({ page }) => {
  await vaultOpen(page)
  const id = unique()
  const root = `suggest${id}`
  const child = `${root}/design`
  const [rootOnly, childTitle] = [`Root only ${id}`, `Child tagged ${id}`]
  await seedNote(page, rootOnly, [root])
  await seedNote(page, childTitle, [root, child])

  await openTagTab(page, root)
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expect(rows(page).filter({ hasText: rootOnly })).toHaveCount(1)
  await expect(rows(page).filter({ hasText: childTitle })).toHaveCount(1)

  const popover = await addTagsCondition(page)
  const value = popover.getByRole('combobox', { name: 'Value' })
  await value.click()

  // Focus alone opens the list: nothing typed yet.
  const list = page.getByRole('listbox', { name: 'Tag suggestions' })
  await expect(list).toBeVisible({ timeout: 10_000 })

  // Every keystroke re-ranks: "design" is only the nested tag's leaf.
  await value.fill('design')
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option').first()).toContainText(child)

  // Arrow and Enter commit the tag into the value, and the list closes.
  await value.press('ArrowDown')
  await value.press('Enter')
  await expect(value).toHaveValue(child)
  await expect(list).toBeHidden()

  // The filter behind it ran: only the note carrying the nested tag is left.
  await page.keyboard.press('Escape')
  await expect(rows(page).filter({ hasText: childTitle })).toHaveCount(1, { timeout: 15_000 })
  await expect(rows(page).filter({ hasText: rootOnly })).toHaveCount(0)
})
