// Multi-tag (AND) selection on a tag's page (#2078), ported from Electron's
// `tag-multi-select.e2e.ts` (Step 30b, #3547): Ctrl/Cmd-clicking a second sidebar tag narrows the
// open tag page's table, which the folder view commands list, to the items carrying both tags,
// and clearing the selection restores the single-tag rows.
import type { Page } from '../../harness/pw-compat/page'
import { expandTagsSection, seedNote, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

async function clickSidebarTag(page: Page, tag: string, additive = false): Promise<void> {
  const button = page.getByRole('button', { name: tag, exact: true }).first()
  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click(additive ? { modifiers: ['ControlOrMeta'] } : undefined)
}

test('Ctrl/Cmd-click ANDs a second tag, and clear-all restores the single tag', async ({
  page
}) => {
  await vaultOpen(page)
  const id = unique()
  const [tagA, tagB] = [`alpha${id}`, `beta${id}`]
  const [both, onlyA] = [`Both ${id}`, `Only alpha ${id}`]
  await seedNote(page, both, [tagA, tagB])
  await seedNote(page, onlyA, [tagA])
  await expandTagsSection(page)

  await clickSidebarTag(page, tagA)
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 })
  await expect(rows(page).filter({ hasText: both })).toHaveCount(1)
  await expect(rows(page).filter({ hasText: onlyA })).toHaveCount(1)

  await clickSidebarTag(page, tagB, true)
  // Still the same tag tab: the additive click does not navigate.
  const bar = page.getByTestId('tag-and-filter-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await expect(bar).toContainText(tagB)
  await expect(rows(page).filter({ hasText: onlyA })).toHaveCount(0)
  await expect(rows(page).filter({ hasText: both })).toHaveCount(1)

  await page.getByTestId('tag-and-filter-clear').click()
  await expect(rows(page).filter({ hasText: onlyA })).toHaveCount(1)
  await expect(rows(page).filter({ hasText: both })).toHaveCount(1)
})

// Electron's restart case saves the AND filter as a named saved filter, which the saved filter
// commands of Step 21 (#3538) port; it runs once they land.
test.skip('a saved multi-tag search reopens the same AND filter after a restart', async () => {})
