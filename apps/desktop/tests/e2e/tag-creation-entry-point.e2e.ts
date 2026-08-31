/**
 * "New tag" in the tag hub, issue #1910.
 *
 * The reported bug is that the hub's create affordance offers both "New
 * category" and "New tag", and only the category half does anything. The tag
 * half wrote a `tag_definitions` row and the very next read
 * (`getAllTagsWithCounts`) deleted it again as an unused orphan, so the tag
 * never reached the list and no restart would have helped.
 *
 * A unit test on the query proves the row survives; only the app can say
 * whether the button in front of the user reaches it. Both halves of the
 * affordance are exercised here so a future change that revives the orphan
 * sweep breaks this rather than shipping quietly.
 */

import { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const UNIQUE = Date.now().toString(36)
const TAG = `Reading${UNIQUE}`

async function openTagHub(page: Page): Promise<void> {
  await page.locator('button[aria-label="Open tag hub"]').click()
  await page.getByRole('button', { name: /new tag/i }).waitFor({ state: 'visible', timeout: 10000 })
}

async function createTag(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /new tag/i }).click()
  await page.getByRole('textbox', { name: 'Tag name' }).fill(name)
  await page.keyboard.press('Enter')
}

/** The chip's `title` is `${tag} (${count})`, so it carries both fields. */
function chip(page: Page, name: string, count: number) {
  return page.locator(`button[title="${name} (${count})"]`)
}

/** Every chip whose tag name matches `name` ignoring case. */
function chipsIgnoringCase(page: Page, name: string) {
  return page.locator(`button[title^="${name} (" i]`)
}

async function listedTags(page: Page): Promise<{ name: string; count: number }[]> {
  return page.evaluate(async () => {
    const { tags } = await window.api.tags.getAllWithCounts()
    return tags.map((t) => ({ name: t.name, count: t.count }))
  })
}

test.describe('Tag hub create affordance', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a tag created from the hub appears in the list without a restart', async ({ page }) => {
    await openTagHub(page)
    await createTag(page, TAG)

    await expect(chip(page, TAG, 0)).toBeVisible({ timeout: 10000 })

    const listed = await listedTags(page)
    const match = listed.filter((t) => t.name.toLowerCase() === TAG.toLowerCase())
    expect(match).toHaveLength(1)
    expect(match[0].name).toBe(TAG)
    expect(match[0].count).toBe(0)
  })

  test('the tag keeps the casing the user typed', async ({ page }) => {
    const name = `Journal${UNIQUE}`

    await openTagHub(page)
    await createTag(page, name)

    await expect(chip(page, name, 0)).toBeVisible({ timeout: 10000 })
    await expect(chip(page, name.toLowerCase(), 0)).toHaveCount(0)

    const listed = await listedTags(page)
    expect(listed.map((t) => t.name)).toContain(name)
  })

  test('creating the same name in another case collides instead of making a second tag', async ({
    page
  }) => {
    const name = `Errand${UNIQUE}`

    await openTagHub(page)
    await createTag(page, name)
    await expect(chip(page, name, 0)).toBeVisible({ timeout: 10000 })

    await createTag(page, name.toLowerCase())

    // `tag_definitions.name` is a COLLATE NOCASE primary key, so the second
    // create resolves to the row the first one made rather than adding a
    // sibling, and the original casing stands.
    await expect(chipsIgnoringCase(page, name)).toHaveCount(1)
    await expect(chip(page, name, 0)).toBeVisible()

    const listed = await listedTags(page)
    const match = listed.filter((t) => t.name.toLowerCase() === name.toLowerCase())
    expect(match).toHaveLength(1)
    expect(match[0].name).toBe(name)
  })
})
