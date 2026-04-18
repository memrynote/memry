import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import { getVisibleDayStart, waitForStable } from './utils/wait-helpers'

const STABLE_FOR_MS = 500
const STABLE_TIMEOUT_MS = 15_000

async function openCalendarWeekView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
  await page.getByTestId('calendar-page').getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'week')
  await expect(page.getByTestId('calendar-week-scroll')).toBeVisible()
  // Let the virtualizer's initial scroll + scroll listener settle so
  // visibleDayStart reflects the landed scrollLeft, not the pre-scroll state.
  await waitForStable(() => getVisibleDayStart(page), {
    stableFor: STABLE_FOR_MS,
    timeout: STABLE_TIMEOUT_MS
  })
}

async function scrollBy(page: Page, deltaX: number): Promise<void> {
  await page
    .getByTestId('calendar-week-scroll')
    .evaluate((el, dx) => (el as HTMLElement).scrollBy({ left: dx, behavior: 'auto' }), deltaX)
}

async function settledVisibleDayStart(page: Page): Promise<number> {
  return waitForStable(() => getVisibleDayStart(page), {
    stableFor: STABLE_FOR_MS,
    timeout: STABLE_TIMEOUT_MS
  })
}

test.describe('Calendar week view infinite horizontal scroll', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('scrolling right advances the visible week and does not snap back', async ({ page }) => {
    await openCalendarWeekView(page)
    const initial = await getVisibleDayStart(page)

    await scrollBy(page, 400)
    const afterScroll = await settledVisibleDayStart(page)
    expect(afterScroll).toBeGreaterThan(initial)

    // no snap-back: after a second settle window, value has not regressed below
    // where it was before.
    const stillAfter = await settledVisibleDayStart(page)
    expect(stillAfter).toBeGreaterThanOrEqual(afterScroll)
  })

  test('scrolling left brings the visible week back toward the origin', async ({ page }) => {
    await openCalendarWeekView(page)
    const initial = await getVisibleDayStart(page)

    await scrollBy(page, 800)
    const afterForward = await settledVisibleDayStart(page)
    expect(afterForward).toBeGreaterThan(initial)

    await scrollBy(page, -500)
    const afterLeft = await settledVisibleDayStart(page)
    expect(afterLeft).toBeLessThan(afterForward)
  })

  test('Today button returns the visible week to the starting position', async ({ page }) => {
    await openCalendarWeekView(page)
    const initial = await getVisibleDayStart(page)

    await scrollBy(page, 1200)
    const scrolledAway = await settledVisibleDayStart(page)
    expect(scrolledAway).toBeGreaterThan(initial)

    await page
      .getByTestId('calendar-page')
      .getByRole('button', { name: 'Today', exact: true })
      .click()

    const afterToday = await settledVisibleDayStart(page)
    // Scroll↔anchor feedback can leave a 1-day rounding slack; anything tighter
    // than that is product-internal and not user-observable.
    expect(Math.abs(afterToday - initial)).toBeLessThanOrEqual(1)
  })

  test('Next button moves the visible week forward and Previous rewinds it', async ({ page }) => {
    await openCalendarWeekView(page)
    const initial = await getVisibleDayStart(page)

    await page.getByTestId('calendar-page').getByRole('button', { name: 'Next period' }).click()
    const afterNext = await settledVisibleDayStart(page)
    const nextDelta = afterNext - initial
    expect(nextDelta).toBeGreaterThanOrEqual(1)
    expect(nextDelta).toBeLessThanOrEqual(14)

    await page.getByTestId('calendar-page').getByRole('button', { name: 'Previous period' }).click()
    const afterPrev = await settledVisibleDayStart(page)
    expect(afterPrev).toBeLessThan(afterNext)
    expect(Math.abs(afterPrev - initial)).toBeLessThanOrEqual(1)
  })
})
