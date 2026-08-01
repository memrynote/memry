// @ts-nocheck
/**
 * Tag custom color E2E
 *
 * Covers the tag page's overflow menu "Change color" submenu — the one
 * reachable surface that hosts the color picker (the create-tag ColorPicker
 * popup is not mounted anywhere in the app, and the Settings → Tags color
 * dialog is not navigable through any existing E2E path; both noted as gaps
 * below). The tag page (`pages/folder-view.tsx` (tag scope)) is opened by clicking a tag in
 * the sidebar — it replaced the sidebar drill-down (`tag-detail-view.tsx`,
 * removed in Task 20) that used to host this menu.
 *
 * Flows:
 *  - Pick a named palette color via the swatch grid → persists, menu stays open.
 *  - Pick a custom hex via the native <input type="color"> → persists.
 *  - The host menu must NOT dismiss when the native picker steals/returns focus
 *    (the reported bug: the dialog closed when the OS color picker opened).
 *
 * Automation boundary: the native OS color chooser cannot be opened or driven
 * from Playwright (it is a separate OS window, and a real click on the input
 * would hang the run). So the "pick a custom color" step sets the input value
 * and dispatches change directly, and the dismiss-guard step reproduces the
 * exact event Radix dismisses on — a `focusin` returning to <body> — after
 * arming the guard with an (untrusted, picker-free) click. The strict
 * before/after proof of the guard lives in the renderer unit test
 * (CustomColorSwatch.test.tsx).
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, SELECTORS } from './utils/electron-helpers'

const UNIQUE = Date.now().toString(36)

async function seedNoteWithTag(page, tag: string): Promise<void> {
  const created = await page.evaluate(async (tagName) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    if (!api?.notes?.create) return false
    const res = await api.notes.create({
      title: `Tag Color ${tagName}`,
      content: `Note body with #${tagName}`,
      tags: [tagName]
    })
    return !!res?.success
  }, tag)
  expect(created).toBeTruthy()
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
  // sidebar drill-down. Wait for the tab and its header's "Tag actions" menu.
  const activeTab = page.locator(SELECTORS.activeTab).first()
  await expect(activeTab).toBeVisible({ timeout: 10000 })
  await expect(activeTab).toContainText(tag)
  await page
    .locator('button[aria-label="Tag actions"]')
    .waitFor({ state: 'visible', timeout: 10000 })
}

async function openChangeColorSubmenu(page): Promise<void> {
  await page.locator('button[aria-label="Tag actions"]').click()
  // Radix submenu opens on hover/click of the sub-trigger.
  const subTrigger = page.getByRole('menuitem', { name: 'Change color' })
  await subTrigger.waitFor({ state: 'visible', timeout: 5000 })
  await subTrigger.click()
  // The native color input lives only inside this submenu (portaled to body).
  await page.locator('input[type="color"]').waitFor({ state: 'visible', timeout: 5000 })
}

async function readTagColor(page, tag: string): Promise<string | undefined> {
  return page.evaluate(async (tagName) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const res = await api.tags.getAllWithCounts()
    return res?.tags?.find((t: { name: string }) => t.name === tagName)?.color
  }, tag)
}

test.describe('Tag custom color', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('selects a named palette color from the swatch grid', async ({ page }) => {
    const tag = `colornamed${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagTab(page, tag)
    await openChangeColorSubmenu(page)

    // Named swatches carry the color name as their title attribute.
    await page.locator('button[title="emerald"]').click()

    await expect.poll(() => readTagColor(page, tag), { timeout: 10000 }).toBe('emerald')
    // Picking a color must not close the menu.
    await expect(page.locator('input[type="color"]')).toBeVisible()
  })

  test('selects a custom hex via the native color input', async ({ page }) => {
    const tag = `colorhex${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagTab(page, tag)
    await openChangeColorSubmenu(page)

    // The native OS chooser can't be driven; drive the input value directly the
    // way a chosen color would, triggering React's onChange.
    await page.locator('input[type="color"]').evaluate((el: HTMLInputElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(el, '#ff8800')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await expect.poll(() => readTagColor(page, tag), { timeout: 10000 }).toBe('#ff8800')
  })

  test('keeps the menu open when the native picker steals/returns focus', async ({ page }) => {
    const tag = `colorguard${UNIQUE}`
    await seedNoteWithTag(page, tag)
    await openTagTab(page, tag)
    await openChangeColorSubmenu(page)

    await page.locator('input[type="color"]').evaluate((el: HTMLInputElement) => {
      // Arm the guard exactly as opening the OS chooser does (untrusted click →
      // no native window, so the run does not hang), then reproduce the
      // focus-return-to-body event Radix would otherwise dismiss the menu on.
      el.click()
      document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    // With the guard the host menu (and its color input) survives the focus churn.
    await expect(page.locator('input[type="color"]')).toBeVisible()
  })
})
