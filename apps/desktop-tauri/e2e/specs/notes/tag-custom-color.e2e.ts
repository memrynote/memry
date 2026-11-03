// A tag's colour from its tab's "Tag actions" menu in the running app (Step 13j, #3530), ported
// from Electron's `tag-custom-color.e2e.ts`: a palette swatch and a custom hex reach the tag's
// definition, and the menu stays open while the native colour chooser takes and returns focus.
import type { Page } from '../../harness/pw-compat/page'
import { listedTags, openTagTab, seedNote, unique, vaultOpen } from '../../harness/tags'
import { test, expect } from '../../harness/test'

async function openChangeColorSubmenu(page: Page, tag: string): Promise<void> {
  await seedNote(page, `Tag Color ${tag}`, [tag])
  await openTagTab(page, tag)
  const actions = page.locator('button[aria-label="Tag actions"]')
  await actions.waitFor({ state: 'visible', timeout: 10_000 })
  await actions.click()
  const subTrigger = page.getByRole('menuitem', { name: 'Change color' })
  await subTrigger.waitFor({ state: 'visible', timeout: 5_000 })
  await subTrigger.click()
  // The native colour input lives only inside this submenu (portaled to body).
  await page.locator('input[type="color"]').waitFor({ state: 'visible', timeout: 5_000 })
}

async function tagColor(page: Page, tag: string): Promise<string | undefined> {
  return (await listedTags(page)).find((listed) => listed.name === tag)?.color
}

test('selects a named palette color from the swatch grid', async ({ page }) => {
  await vaultOpen(page)
  const tag = `colornamed${unique()}`
  await openChangeColorSubmenu(page, tag)

  await page.locator('button[title="emerald"]').click()
  await expect.poll(() => tagColor(page, tag), { timeout: 10_000 }).toBe('emerald')
  await expect(page.locator('input[type="color"]')).toBeVisible()
})

test('selects a custom hex via the native color input', async ({ page }) => {
  await vaultOpen(page)
  const tag = `colorhex${unique()}`
  await openChangeColorSubmenu(page, tag)

  // The native chooser cannot be driven; set the input's value the way a chosen colour would,
  // which triggers React's onChange.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="color"]')
    if (!input) throw new Error('no colour input')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, '#ff8800')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect.poll(() => tagColor(page, tag), { timeout: 10_000 }).toBe('#ff8800')
})

test('keeps the menu open when the native picker steals/returns focus', async ({ page }) => {
  await vaultOpen(page)
  const tag = `colorguard${unique()}`
  await openChangeColorSubmenu(page, tag)

  await page.evaluate(() => {
    // Arm the guard as opening the OS chooser does (an untrusted click opens no native window),
    // then send the focus-return-to-body event Radix would otherwise dismiss the menu on.
    document.querySelector<HTMLInputElement>('input[type="color"]')?.click()
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  await expect(page.locator('input[type="color"]')).toBeVisible()
})
