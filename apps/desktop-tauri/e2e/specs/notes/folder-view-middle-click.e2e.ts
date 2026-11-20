// Middle-click on a folder view or tag page row opens the note in a background tab (Step 30b,
// #3547), ported from Electron's `folder-view-middle-click.e2e.ts`. The claim is about the tab
// strip, so it is driven against the real app.
import { createNote, expandCollections, treeRow, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { ACTIVE_TAB, openTagTab, unique } from '../../harness/tags'
import { test, expect } from '../../harness/test'

const TABS = '[role="tab"][data-group-id]'

const rows = (page: Page) => page.getByRole('table').locator('tbody tr')

/** Middle-clicks the row carrying `title` and checks a background tab arrived. */
async function expectBackgroundOpen(page: Page, title: string, activeText: string): Promise<void> {
  const before = await page.locator(TABS).count()
  await rows(page).filter({ hasText: title }).first().click({ button: 'middle' })

  await expect.poll(() => page.locator(TABS).count()).toBe(before + 1)
  await expect(page.locator(TABS).filter({ hasText: title }).first()).toBeVisible()
  // Background: the page the click came from keeps the focus.
  await expect(page.locator(ACTIVE_TAB).first()).toContainText(activeText)
}

test('middle-click on a tag page row opens it in a background tab', async ({ page }) => {
  await vaultOpen(page)
  const id = unique()
  const [tag, title] = [`middle${id}`, `Tagged row ${id}`]
  await createNote(page, { title, content: 'Lives on the tag page', tags: [tag] })

  await openTagTab(page, tag)
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expectBackgroundOpen(page, title, tag)
})

test('middle-click on a folder view row opens it in a background tab', async ({ page }) => {
  await vaultOpen(page)
  const id = unique()
  const [folder, title] = [`Middle${id}`, `Folder row ${id}`]
  await createNote(page, { title, content: 'Lives in a folder', folder })

  await expandCollections(page)
  const folderRow = treeRow(page, `folder-${folder}`)
  await expect(folderRow).toBeVisible({ timeout: 20_000 })
  // A plain click on a folder row only expands it; the folder view has its own button on the row,
  // transparent until hover. WKWebView sets no `:hover` for a WebDriver pointer, and the row's key
  // handler takes Enter, so the button is clicked through its transparency, as Electron's spec did.
  await folderRow.getByRole('button', { name: 'Open folder view' }).click({ force: true })
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expectBackgroundOpen(page, title, folder)
})
