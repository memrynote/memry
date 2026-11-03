// The tag surfaces the tag specs drive (Step 13j, #3530): notes seeded through `notes_create` as
// the renderer calls it, the sidebar's Tags section, the tag hub and a tag's tab.
import { expect } from './pw-compat/expect'
import type { Page } from './pw-compat/page'
import { invoke, vaultStatus } from './vault-commands'
import { pollUntil } from './wait'

export const ACTIVE_TAB = '[role="tab"][data-group-id][aria-selected="true"]'

export interface ListedTag {
  name: string
  count: number
  color: string
  icon: string | null
}

/** A name no other test or run shares. */
export const unique = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export async function vaultOpen(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** A note carrying `tags` in its frontmatter and its record, as the app's create writes it. */
export async function seedNote(page: Page, title: string, tags: string[]): Promise<void> {
  await invoke(page, 'notes_create', { input: { title, content: 'Note body', tags } })
}

export const listedTags = (page: Page) => invoke<ListedTag[]>(page, 'tags_get_all_with_counts')

export async function expandTagsSection(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Tags section, "]')
  await trigger.waitFor({ state: 'visible', timeout: 10_000 })
  if (((await trigger.getAttribute('aria-label')) ?? '').includes('collapsed')) {
    await trigger.click()
    await page
      .locator('button[aria-label^="Tags section, expanded"]')
      .waitFor({ state: 'visible', timeout: 5_000 })
  }
}

/** Opens the tag hub and waits for its create affordance. */
export async function openTagHub(page: Page, affordance: RegExp): Promise<void> {
  await page.locator('button[aria-label="Open tag hub"]').click()
  await page
    .getByRole('button', { name: affordance })
    .waitFor({ state: 'visible', timeout: 10_000 })
}

/** Clicks `tag` in the sidebar and waits for the tag's tab. */
export async function openTagTab(page: Page, tag: string): Promise<void> {
  await expandTagsSection(page)
  const button = page.getByRole('button', { name: tag, exact: true }).first()
  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click()
  const activeTab = page.locator(ACTIVE_TAB).first()
  await expect(activeTab).toBeVisible({ timeout: 10_000 })
  await expect(activeTab).toContainText(tag)
}
