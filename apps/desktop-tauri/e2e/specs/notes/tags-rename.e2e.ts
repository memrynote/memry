// A tag renamed from its tab's "Tag actions" menu in the running app (Step 13j-4, #3530), the
// rename half of Electron's `tags-rename-delete.e2e.ts` (the delete half waits for `tags_delete`):
// the dialog opens on the tag's name, Save renames it in the note's header, body and record, the
// tag's tab closes, and the sidebar lists the new name in place of the old.
import { createNote, getNote } from '../../harness/notes'
import { expandTagsSection, openTagTab, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

test('renames a tag via overflow menu', async ({ page }) => {
  await vaultOpen(page)
  const name = unique()
  const tag = `renamecandidate${name}`
  const renamed = `renamed${name}`
  const { id } = await createNote(page, {
    title: `Tag Test ${tag}`,
    content: `Note body #${tag}`,
    tags: [tag]
  })
  await openTagTab(page, tag)

  await page.locator('button[aria-label="Tag actions"]').click()
  await page.getByRole('menuitem', { name: 'Rename tag' }).click()
  const input = page.locator('#tag-rename-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue(tag)
  await input.fill(renamed)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // The tag's tab closes on the rename: an open tab is not renamed in place.
  await expect(page.locator('[role="tab"]').filter({ hasText: tag })).toHaveCount(0, {
    timeout: 10_000
  })
  await expandTagsSection(page)
  await expect(page.getByRole('button', { name: renamed, exact: true }).first()).toBeVisible({
    timeout: 10_000
  })
  await expect(page.getByRole('button', { name: tag, exact: true })).toHaveCount(0)

  const note = await getNote(page, id)
  expect(note?.headerTags).toEqual([renamed])
  expect(note?.tags).toEqual([renamed])
  expect(note?.content).toContain(`#${renamed}`)
})
