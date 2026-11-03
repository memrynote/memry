// Tag categories in the running app (Step 13j, #3530), ported from Electron's
// `tag-categories.e2e.ts`: a sidebar tag opens the tag's own tab, and a category made in the tag
// hub is a synced record that survives a restart. The tab's table of items is the folder view's
// (Step 30, #3547), which carries Electron's table assertion.
import { restart } from '../../harness/tauri-lifecycle'
import { openTagHub, openTagTab, seedNote, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

test('clicking a sidebar tag opens a tab for the tag', async ({ page }) => {
  await vaultOpen(page)
  const tag = `meetings${unique()}`
  await seedNote(page, `Tag Category Test ${tag}`, [tag])
  await openTagTab(page, tag)
})

test('a category created in the hub persists across a restart', async ({ app, page }) => {
  await vaultOpen(page)
  const category = `Restart ${unique()}`
  await openTagHub(page, /new category/i)
  await page.getByRole('button', { name: /new category/i }).click()
  await page.getByRole('textbox', { name: 'Category name' }).fill(category)
  await page.keyboard.press('Enter')
  await expect(page.getByText(category)).toBeVisible({ timeout: 10_000 })

  await restart(app)
  await vaultOpen(page)
  await openTagHub(page, /new category/i)
  await expect(page.getByText(category)).toBeVisible({ timeout: 15_000 })
})
