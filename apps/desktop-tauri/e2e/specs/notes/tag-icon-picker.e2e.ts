// A tag's icon in the running app (Step 13j, #3530), ported from Electron's
// `tag-icon-picker.e2e.ts`: the shared emoji and icon picker opens from Settings › Tags and from
// the tag's tab, and a chosen icon shows in the sidebar's tag list and the settings row.
import type { Page } from '../../harness/pw-compat/page'
import { expandTagsSection, openTagTab, seedNote, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria

/** Opens Settings › Tags and waits for `tag`'s row: a row list that changes closes a picker. */
async function openTagsSettings(page: Page, tag: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Tags & Properties', exact: true }).click()
  await expect(page.getByTestId('settings-view').getByText(tag, { exact: true })).toBeVisible({
    timeout: 15_000
  })
}

/** The settings view's first tag row chip, and the tag tab's header chip. */
const SETTINGS_CHIP = '[data-testid="settings-view"] button[aria-label="Change icon"]'
const TAB_CHIP = 'button[aria-label="Change icon"]'

/**
 * Clicks a chip the way the DOM does. A click through this driver ends with the harness's
 * synthetic `pointerdown` (WebKit's driver sends none), which the modal popover the click just
 * opened takes as a press outside, and closes on.
 */
async function openPicker(page: Page, chip: string): Promise<void> {
  await expect(page.locator(chip).first()).toBeVisible({ timeout: 15_000 })
  await page.evaluate((selector: string) => {
    document.querySelector<HTMLButtonElement>(selector)?.click()
  }, chip)
}

/** Picks the first icon of the picker's Icons tab: emoji-mart's virtualised grid is too fragile. */
async function pickFirstIcon(page: Page): Promise<void> {
  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: 'Icons' }).click()
  const firstIcon = picker.locator('button[title]').first()
  await firstIcon.waitFor({ state: 'visible', timeout: 10_000 })
  await firstIcon.click()
  await expect(picker).toBeHidden({ timeout: 5_000 })
}

test('settings: each tag row opens the icon/emoji picker', async ({ page }) => {
  await vaultOpen(page)
  const tag = `seticon${unique()}`
  await seedNote(page, 'Icon Test', [tag])
  await openTagsSettings(page, tag)

  await openPicker(page, SETTINGS_CHIP)
  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Emoji' })).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Icons' })).toBeVisible()
})

test('sidebar: the tag tab opens the same picker', async ({ page }) => {
  await vaultOpen(page)
  const tag = `sideicon${unique()}`
  await seedNote(page, `Icon Test ${tag}`, [tag])
  await openTagTab(page, tag)

  await openPicker(page, TAB_CHIP)
  await expect(page.getByRole('dialog', { name: PICKER })).toBeVisible()
})

test('a chosen emoji renders in the sidebar list and settings row', async ({ page }) => {
  await vaultOpen(page)
  const tag = `showicon${unique()}`
  const emoji = '📚'
  await seedNote(page, `Icon Test ${tag}`, [tag])
  // `tags_update_icon` is what the picker calls on select.
  await invoke(page, 'tags_update_icon', { tag, icon: emoji })

  // Not an exact name: once the icon is applied the row's name is "📚 <tag>".
  await expandTagsSection(page)
  const tagRow = page.getByRole('button', { name: tag }).first()
  await expect(tagRow).toBeVisible({ timeout: 15_000 })
  await expect(tagRow.getByText(emoji)).toBeVisible({ timeout: 15_000 })

  // Scoped to the settings view: the sidebar stays mounted, hidden, behind it.
  await openTagsSettings(page, tag)
  await expect(page.getByTestId('settings-view').getByText(emoji).first()).toBeVisible()
})

test('picking an icon from the picker persists and re-displays it', async ({ page }) => {
  await vaultOpen(page)
  const tag = `pickicon${unique()}`
  await seedNote(page, `Icon Test ${tag}`, [tag])
  await openTagTab(page, tag)

  await openPicker(page, TAB_CHIP)
  await pickFirstIcon(page)
  // A leaf row has no other svg, so the icon's is the one.
  await expandTagsSection(page)
  const tagRow = page.getByRole('button', { name: tag }).first()
  await expect(tagRow.locator('svg')).toHaveCount(1, { timeout: 15_000 })
})

test('settings: picking an icon inside settings persists and re-displays it', async ({ page }) => {
  // Electron regression: a picker portaled out of a modal settings dialog showed but took no
  // clicks. Kept so the picker stays clickable from settings.
  await vaultOpen(page)
  const tag = `modalpick${unique()}`
  await seedNote(page, 'Icon Test', [tag])
  await openTagsSettings(page, tag)

  await openPicker(page, SETTINGS_CHIP)
  await pickFirstIcon(page)
  await expect(page.locator(SETTINGS_CHIP).first().locator('svg')).toHaveCount(1, {
    timeout: 15_000
  })
})
