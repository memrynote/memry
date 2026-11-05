// A tag renamed and a tag deleted from its tab's "Tag actions" menu in the running app (Step
// 13j-4, #3530), after Electron's `tags-rename-delete.e2e.ts`. Rename: the dialog opens on the
// tag's name, Save renames it in the note's header, body and record, the tag's tab closes, and the
// sidebar lists the new name in place of the old. Delete: the dialog asks, the confirm takes the
// tag off the note's header and record, the tag's tab closes, and the sidebar no longer lists it;
// a #tag written in a note's text stays there, so the sidebar still lists it for that note.
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

test('deletes a tag via overflow menu', async ({ page }) => {
  await vaultOpen(page)
  const tag = `deletecandidate${unique()}`
  const { id } = await createNote(page, {
    title: `Tag Test ${tag}`,
    content: 'Note body',
    tags: [tag]
  })
  await openTagTab(page, tag)

  await page.locator('button[aria-label="Tag actions"]').click()
  await page.getByRole('menuitem', { name: 'Delete tag' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByText(`Delete tag #${tag}?`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete tag' }).click()

  // The tag's tab closes on the delete, as on a rename.
  await expect(page.locator('[role="tab"]').filter({ hasText: tag })).toHaveCount(0, {
    timeout: 10_000
  })
  await expandTagsSection(page)
  await expect(page.getByRole('button', { name: tag, exact: true })).toHaveCount(0, {
    timeout: 10_000
  })

  const note = await getNote(page, id)
  expect(note?.headerTags).toEqual([])
  expect(note?.tags).toEqual([])
})

test('a deleted tag written in a note body stays in the body and the sidebar', async ({ page }) => {
  await vaultOpen(page)
  const tag = `deletebody${unique()}`
  const { id } = await createNote(page, {
    title: `Tag Test ${tag}`,
    content: `Note body #${tag}`,
    tags: [tag]
  })
  await openTagTab(page, tag)

  await page.locator('button[aria-label="Tag actions"]').click()
  await page.getByRole('menuitem', { name: 'Delete tag' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByText(`#${tag} written in note text stays`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete tag' }).click()

  await expect(page.locator('[role="tab"]').filter({ hasText: tag })).toHaveCount(0, {
    timeout: 10_000
  })
  const note = await getNote(page, id)
  expect(note?.headerTags).toEqual([])
  expect(note?.content).toContain(`#${tag}`)
  await expandTagsSection(page)
  await expect(page.getByRole('button', { name: tag, exact: true }).first()).toBeVisible({
    timeout: 10_000
  })
})
