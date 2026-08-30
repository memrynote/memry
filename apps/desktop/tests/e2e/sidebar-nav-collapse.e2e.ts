/**
 * The sidebar's nav block (Home, Inbox, Journal, Calendar, Tasks, Tags) held its
 * height no matter what, and the tree below lived in whatever was left over.
 *
 * The reclaim only exists end to end: the header folds a grid row, the tree is
 * the flex-1 sibling that grows into the space, and the flag round-trips through
 * the data-DB settings table. A jsdom test can prove the attribute flips; only
 * the app can prove the tree is actually taller and stays that way over a reload.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding
} from './utils/electron-helpers'

/** The scroll area holding the sections — the only thing that can take the space. */
const TREE = '[data-tour="sidebar-collections"]'
const NAV_ITEMS = '[data-testid="sidebar-nav-items"]'
const TOGGLE = '[data-testid="sidebar-nav-toggle"]'

async function ready(page: Page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
  await page.locator(TOGGLE).waitFor({ state: 'visible', timeout: 30_000 })
}

/** What the app persisted, independent of what is on screen. */
async function savedNavCollapsed(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const preload = (window as unknown as { api: Record<string, any> }).api
    return (await preload.settings.getSidebarNavCollapsed()) as boolean
  })
}

/** Wait until an element stops moving, then hand back its box. */
async function settleBox(locator: ReturnType<Page['locator']>): Promise<void> {
  let previous = ''
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox()
        const current = box ? `${Math.round(box.x)},${Math.round(box.y)}` : ''
        const stable = current !== '' && current === previous
        previous = current
        return stable
      },
      { timeout: 10_000, intervals: [150] }
    )
    .toBe(true)
}

/**
 * Wait until an element stops resizing, then hand back its height.
 *
 * Measured off `getBoundingClientRect`, not `boundingBox()`: a collapsed nav is
 * exactly the zero-height element Playwright reports as `null`, and zero is the
 * number this spec most needs to read.
 */
async function measureHeight(locator: ReturnType<Page['locator']>): Promise<number> {
  return locator.evaluate((node) => Math.round(node.getBoundingClientRect().height))
}

async function settleHeight(locator: ReturnType<Page['locator']>): Promise<number> {
  let previous = -1
  await expect
    .poll(
      async () => {
        const current = await measureHeight(locator)
        const stable = current === previous
        previous = current
        return stable
      },
      { timeout: 20_000, intervals: [200] }
    )
    .toBe(true)

  return measureHeight(locator)
}

test.describe('Sidebar nav collapse', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a fresh vault renders the nav expanded and saves nothing', async ({ page }) => {
    expect(await savedNavCollapsed(page)).toBe(false)

    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(NAV_ITEMS)).toHaveAttribute('aria-hidden', 'false')
    await expect(page.locator(`${NAV_ITEMS} [data-tour^="nav-"]`).first()).toBeVisible()
  })

  test('collapsing the nav hands its height to the tree and persists', async ({ page }) => {
    const nav = page.locator(NAV_ITEMS)
    const tree = page.locator(TREE)

    await settleBox(nav)
    await settleBox(tree)
    const navHeight = await settleHeight(nav)
    const treeBefore = await settleHeight(tree)

    await page.locator(TOGGLE).click()
    await settleBox(tree)

    // Two subpixel boxes, so the tree is allowed to come back a few px short of
    // the rows it replaced, and nothing else on the reclaim is negotiable.
    expect(await settleHeight(tree)).toBeGreaterThanOrEqual(treeBefore + navHeight - 8)
    expect(await settleHeight(nav)).toBeLessThanOrEqual(1)

    await expect.poll(async () => savedNavCollapsed(page), { timeout: 20_000 }).toBe(true)
  })

  test('the collapsed nav survives a reload', async ({ page }) => {
    const tree = page.locator(TREE)
    await settleBox(tree)

    await page.locator(TOGGLE).click()
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-expanded', 'false')
    await settleBox(tree)
    const reclaimed = await settleHeight(tree)

    await page.reload()
    await ready(page)

    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(async () => measureHeight(tree), { timeout: 20_000, intervals: [200] })
      .toBeGreaterThanOrEqual(reclaimed - 8)
    expect(await savedNavCollapsed(page)).toBe(true)
  })
})
