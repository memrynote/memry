// "New tag" in the tag hub (Electron #1910) in the running app (Step 13j, #3530), ported from
// Electron's `tag-creation-entry-point.e2e.ts`: a tag made from the hub reaches the list at
// once, keeps the spelling typed, and a second spelling of it lands on the same tag.
import type { Page } from '../../harness/pw-compat/page'
import { listedTags, openTagHub, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

async function createTag(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /new tag/i }).click()
  await page.getByRole('textbox', { name: 'Tag name' }).fill(name)
  await page.keyboard.press('Enter')
}

/** The chip's `title` is `${tag} (${count})`, so it carries both fields. */
const chip = (page: Page, name: string, count: number) =>
  page.locator(`button[title="${name} (${count})"]`)

/** Every chip whose tag name matches `name` ignoring case. */
const chipsIgnoringCase = (page: Page, name: string) => page.locator(`button[title^="${name} (" i]`)

async function listedAs(page: Page, name: string): Promise<{ name: string; count: number }[]> {
  const tags = await listedTags(page)
  return tags
    .filter((tag) => tag.name.toLowerCase() === name.toLowerCase())
    .map(({ name: listed, count }) => ({ name: listed, count }))
}

test('a tag created from the hub appears in the list without a restart', async ({ page }) => {
  await vaultOpen(page)
  const tag = `Reading${unique()}`
  await openTagHub(page, /new tag/i)
  await createTag(page, tag)

  await expect(chip(page, tag, 0)).toBeVisible({ timeout: 10_000 })
  expect(await listedAs(page, tag)).toEqual([{ name: tag, count: 0 }])
})

test('the tag keeps the casing the user typed', async ({ page }) => {
  await vaultOpen(page)
  const tag = `Journal${unique()}`
  await openTagHub(page, /new tag/i)
  await createTag(page, tag)

  await expect(chip(page, tag, 0)).toBeVisible({ timeout: 10_000 })
  await expect(chip(page, tag.toLowerCase(), 0)).toHaveCount(0)
  expect((await listedTags(page)).map((listed) => listed.name)).toContain(tag)
})

test('creating the same name in another case collides instead of making a second tag', async ({
  page
}) => {
  await vaultOpen(page)
  const tag = `Errand${unique()}`
  await openTagHub(page, /new tag/i)
  await createTag(page, tag)
  await expect(chip(page, tag, 0)).toBeVisible({ timeout: 10_000 })

  await createTag(page, tag.toLowerCase())
  // A definition is keyed by the tag's fold, so the second create edits the first one and its
  // spelling stands.
  await expect(chipsIgnoringCase(page, tag)).toHaveCount(1)
  await expect(chip(page, tag, 0)).toBeVisible()
  expect(await listedAs(page, tag)).toEqual([{ name: tag, count: 0 }])
})
