// @ts-nocheck
/**
 * Tag Icon Picker E2E
 *
 * The per-tag icon/emoji picker must be reachable from BOTH places a user
 * manages tags, and the chosen icon must show up where tags are listed:
 *
 *  1. Settings → Tags: each tag row has an icon chip that opens the shared
 *     emoji/icon picker.
 *  2. Sidebar → click a tag to open its tag tab (`pages/folder-view.tsx` (tag scope),
 *     replacing the sidebar drill-down `tag-detail-view.tsx` removed in Task
 *     20): the tag page header chip opens the same picker (this surface had
 *     only a static color dot before).
 *  3. A chosen icon renders in the sidebar tag list and the settings tag row.
 *  4. Picking an icon from the picker UI round-trips: persist → re-display.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, SELECTORS } from './utils/electron-helpers'

const UNIQUE = Date.now().toString(36)
const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria

async function seedNoteWithTag(page, tag: string): Promise<void> {
  const created = await page.evaluate(async (tagName) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    if (!api?.notes?.create) return false
    const res = await api.notes.create({
      title: `Icon Test ${tagName}`,
      content: `Note body with #${tagName}`,
      tags: [tagName]
    })
    return !!res?.success
  }, tag)
  expect(created).toBeTruthy()
}

async function setTagIcon(page, tag: string, icon: string): Promise<void> {
  const ok = await page.evaluate(
    async ({ tag, icon }) => {
      const api = (window as unknown as { api: Record<string, any> }).api
      const res = await api.tags.updateTagIcon({ tag, icon })
      return !!res?.success
    },
    { tag, icon }
  )
  expect(ok).toBeTruthy()
}

async function openTagsSettings(page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { api: Record<string, any> }).api.quickCapture.openSettings('tags')
  })
  // The icon chip only exists in the Tags settings panel — wait for it.
  await expect(page.getByRole('button', { name: 'Change icon' }).first()).toBeVisible({
    timeout: 15000
  })
}

async function expandTagsSection(page): Promise<void> {
  const trigger = page.locator('button[aria-label^="Tags section, "]')
  await trigger.waitFor({ state: 'visible', timeout: 10000 })
  const label = (await trigger.getAttribute('aria-label')) ?? ''
  if (label.includes('collapsed')) {
    await trigger.click()
    await page.locator('button[aria-label^="Tags section, expanded"]').waitFor({
      state: 'visible',
      timeout: 5000
    })
  }
}

async function openTagTab(page, tag: string): Promise<void> {
  await expandTagsSection(page)
  const tagTrigger = page.getByRole('button', { name: tag, exact: true }).first()
  await tagTrigger.waitFor({ state: 'visible', timeout: 15000 })
  await tagTrigger.click()
  // Clicking a tag opens a `tag` tab (pages/folder-view.tsx, tag scope) rather than the old
  // sidebar drill-down. Wait for the tab and its header's icon chip.
  const activeTab = page.locator(SELECTORS.activeTab).first()
  await expect(activeTab).toBeVisible({ timeout: 10000 })
  await expect(activeTab).toContainText(tag)
  await page.getByRole('button', { name: 'Change icon' }).waitFor({
    state: 'visible',
    timeout: 10000
  })
}

test.describe('Tag icon picker', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('settings: each tag row opens the icon/emoji picker', async ({ page }) => {
    const tag = `seticon${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagsSettings(page)

    await page.getByRole('button', { name: 'Change icon' }).first().click()

    const picker = page.getByRole('dialog', { name: PICKER })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Emoji' })).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Icons' })).toBeVisible()
  })

  test('sidebar: the tag tab opens the same picker', async ({ page }) => {
    const tag = `sideicon${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagTab(page, tag)

    // This chip replaced the old static color dot — it must open the picker.
    const chip = page.getByRole('button', { name: 'Change icon' })
    await expect(chip).toBeVisible()
    await chip.click()

    await expect(page.getByRole('dialog', { name: PICKER })).toBeVisible()
  })

  test('a chosen emoji renders in the sidebar list and settings row', async ({ page }) => {
    const tag = `showicon${UNIQUE}`
    const emoji = '📚'
    await seedNoteWithTag(page, tag)
    // updateTagIcon is exactly what the picker calls on select.
    await setTagIcon(page, tag, emoji)

    // Sidebar tag list row shows the emoji glyph. Non-exact name match: once the
    // icon is applied, the row's accessible name becomes "📚 <tag>", so an exact
    // match would race the tag-list refetch.
    await expandTagsSection(page)
    const tagRow = page.getByRole('button', { name: tag }).first()
    await expect(tagRow).toBeVisible({ timeout: 15000 })
    await expect(tagRow.getByText(emoji)).toBeVisible({ timeout: 15000 })

    // Settings tag row chip shows it too.
    await openTagsSettings(page)
    await expect(page.getByText(emoji).first()).toBeVisible()
  })

  test('picking an icon from the picker persists and re-displays it', async ({ page }) => {
    const tag = `pickicon${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagTab(page, tag)

    await page.getByRole('button', { name: 'Change icon' }).click()
    const picker = page.getByRole('dialog', { name: PICKER })
    await expect(picker).toBeVisible()

    // Icons tab has deterministic buttons (each carries a title); emoji-mart's
    // virtualized grid is too fragile to click a specific cell reliably.
    await picker.getByRole('button', { name: 'Icons' }).click()
    const firstIcon = picker.locator('button[title]').first()
    await firstIcon.waitFor({ state: 'visible', timeout: 10000 })
    await firstIcon.click()

    // Picker closes and the icon now renders on the sidebar tag list row
    // (a leaf row has no other svg, so the icon's svg is unambiguous).
    await expect(picker).toBeHidden({ timeout: 5000 })
    await expandTagsSection(page)
    const tagRow = page.getByRole('button', { name: tag }).first()
    await expect(tagRow.locator('svg')).toHaveCount(1, { timeout: 15000 })
  })

  test('settings: picking an icon inside the modal persists and re-displays it', async ({
    page
  }) => {
    // Regression: Settings is a modal Radix Dialog. A picker portaled to
    // document.body inherits the dialog's pointer-events:none, so it shows but
    // clicks never land. Hosting it in a Radix Popover (modal) restores clicks.
    const tag = `modalpick${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagsSettings(page)

    const chip = page.getByRole('button', { name: 'Change icon' }).first()
    await chip.click()

    const picker = page.getByRole('dialog', { name: PICKER })
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Icons' }).click()
    const firstIcon = picker.locator('button[title]').first()
    await firstIcon.waitFor({ state: 'visible', timeout: 10000 })
    await firstIcon.click()

    // The click must register (it did not when the picker was inert): picker
    // closes and the row's chip now shows the chosen icon's svg.
    await expect(picker).toBeHidden({ timeout: 5000 })
    await expect(chip.locator('svg')).toHaveCount(1, { timeout: 15000 })
  })
})
