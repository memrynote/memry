import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

async function openCalendarWeekView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
  await page.getByTestId('calendar-page').getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'week')
  await expect(page.getByTestId('calendar-week-scroll')).toBeVisible()
}

async function getScrollLeft(page: Page): Promise<number> {
  return await page
    .getByTestId('calendar-week-scroll')
    .evaluate((el) => (el as HTMLElement).scrollLeft)
}

async function scrollBy(page: Page, deltaX: number): Promise<void> {
  await page
    .getByTestId('calendar-week-scroll')
    .evaluate((el, dx) => (el as HTMLElement).scrollBy({ left: dx, behavior: 'auto' }), deltaX)
}

async function waitForScrollSettle(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms)
}

test.describe('Calendar week view infinite horizontal scroll', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('scrolls right and stays at the new position (no snap-back to today)', async ({ page }) => {
    // #given — calendar opened on Week view
    await openCalendarWeekView(page)
    const initial = await getScrollLeft(page)

    // #when — scroll right by ~2 day columns worth of pixels
    await scrollBy(page, 400)
    await waitForScrollSettle(page)

    // #then — scrollLeft advanced and did NOT snap back
    const afterScroll = await getScrollLeft(page)
    expect(afterScroll).toBeGreaterThan(initial + 100)

    // #and — wait a bit longer; still no snap-back
    await waitForScrollSettle(page, 600)
    const afterWait = await getScrollLeft(page)
    expect(afterWait).toBeGreaterThanOrEqual(afterScroll - 10)
  })

  test('scrolls left and stays at the new position', async ({ page }) => {
    // #given — calendar opened on Week view, then user scrolled forward first
    await openCalendarWeekView(page)
    const initial = await getScrollLeft(page)
    await scrollBy(page, 800)
    await waitForScrollSettle(page)
    const forward = await getScrollLeft(page)
    expect(forward).toBeGreaterThan(initial + 400)

    // #when — scroll back left
    await scrollBy(page, -500)
    await waitForScrollSettle(page)

    // #then — scrollLeft decreased and did not snap forward
    const afterLeft = await getScrollLeft(page)
    expect(afterLeft).toBeLessThan(forward - 200)
    expect(afterLeft).toBeGreaterThan(initial - 10)

    await waitForScrollSettle(page, 600)
    const afterWait = await getScrollLeft(page)
    expect(Math.abs(afterWait - afterLeft)).toBeLessThan(20)
  })

  test('Today button smooth-scrolls back to todays week after scrolling forward', async ({
    page
  }) => {
    // #given — user has scrolled far forward
    await openCalendarWeekView(page)
    const initial = await getScrollLeft(page)
    await scrollBy(page, 1200)
    await waitForScrollSettle(page)
    const advanced = await getScrollLeft(page)
    expect(advanced).toBeGreaterThan(initial + 500)

    // #when — click Today
    await page
      .getByTestId('calendar-page')
      .getByRole('button', { name: 'Today', exact: true })
      .click()
    await waitForScrollSettle(page, 800)

    // #then — scroll returns near the original position
    const afterToday = await getScrollLeft(page)
    expect(Math.abs(afterToday - initial)).toBeLessThan(50)
  })

  test('Next button advances the visible week by 7 days worth of scroll', async ({ page }) => {
    // #given — week view at today
    await openCalendarWeekView(page)
    const initial = await getScrollLeft(page)

    // #when — click Next
    await page.getByTestId('calendar-page').getByRole('button', { name: 'Next period' }).click()
    await waitForScrollSettle(page, 800)

    // #then — scroll advanced by ~7 columns (lower bound to accommodate any column-width variance)
    const afterNext = await getScrollLeft(page)
    expect(afterNext).toBeGreaterThan(initial + 200)

    // #and — Previous brings it back
    await page.getByTestId('calendar-page').getByRole('button', { name: 'Previous period' }).click()
    await waitForScrollSettle(page, 800)
    const afterPrev = await getScrollLeft(page)
    expect(Math.abs(afterPrev - initial)).toBeLessThan(50)
  })
})
