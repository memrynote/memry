import { test, expect, type Page, type Locator } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

/**
 * NOTE: Playwright runs against the built Electron bundle (`out/main/index.js`).
 * After editing renderer / main source, rebuild with `npx electron-vite build`
 * before re-running these tests. CI does a `pnpm build` first.
 */

async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
}

async function switchView(page: Page, label: 'Day' | 'Week'): Promise<void> {
  await page.getByTestId('calendar-page').getByRole('button', { name: label, exact: true }).click()
  const expectedAttr = label.toLowerCase()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', expectedAttr)
}

async function scrollGridToTop(view: Locator): Promise<void> {
  await view.evaluate((el) => {
    let parent: HTMLElement | null = el.parentElement
    while (parent) {
      const overflow = getComputedStyle(parent).overflowY
      if (overflow === 'auto' || overflow === 'scroll') {
        parent.scrollTop = 0
        break
      }
      parent = parent.parentElement
    }
  })
}

async function dragTimeRange(
  page: Page,
  view: Locator,
  xInset: number,
  yStartInset: number,
  yEndInset: number
): Promise<void> {
  const box = await view.boundingBox()
  if (!box) throw new Error('calendar view has no bounding box')
  const x = box.x + xInset
  const yStart = box.y + yStartInset
  const yEnd = box.y + yEndInset

  await page.mouse.move(x, yStart)
  await page.mouse.down()
  await page.mouse.move(x, yEnd, { steps: 8 })
  await page.mouse.up()
}

test.describe('Calendar — marquee quick-create', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('drag selection on day view creates an event after typing a title', async ({ page }) => {
    const title = `MarqueeE2E-${Date.now()}`

    await openCalendar(page)
    await switchView(page, 'Day')

    const dayView = page.getByTestId('calendar-view')
    await expect(dayView).toBeVisible()
    await scrollGridToTop(dayView)
    await page.waitForTimeout(100)

    await dragTimeRange(page, dayView, 140, 96, 192)

    const popover = page.getByTestId('quick-create-popover')
    await expect(popover).toBeVisible()

    const titleInput = popover.getByPlaceholder('New Event')
    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(popover).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  // H2 — Save button click path (not Enter)
  test('day view: clicking the Save button creates an event', async ({ page }) => {
    const title = `MarqueeSaveBtn-${Date.now()}`

    await openCalendar(page)
    await switchView(page, 'Day')

    const dayView = page.getByTestId('calendar-view')
    await expect(dayView).toBeVisible()
    await scrollGridToTop(dayView)
    await page.waitForTimeout(100)

    await dragTimeRange(page, dayView, 140, 96, 192)

    const popover = page.getByTestId('quick-create-popover')
    await expect(popover).toBeVisible()
    await popover.getByPlaceholder('New Event').fill(title)
    await popover.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(popover).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  // H3 — week view drag on a non-first day column
  test('week view: drag on a non-first column creates an event', async ({ page }) => {
    const title = `MarqueeWeekCol-${Date.now()}`

    await openCalendar(page)
    await switchView(page, 'Week')

    const weekView = page.getByTestId('calendar-view')
    await expect(weekView).toBeVisible()
    await scrollGridToTop(weekView)
    await page.waitForTimeout(100)

    // The week grid is: [gutter col ~72px @xl | 7 day cols equally wide]
    // Pick a column roughly mid-week (Wed/Thu).
    const box = await weekView.boundingBox()
    if (!box) throw new Error('week view has no bounding box')
    const gutter = 72
    const dayColumnWidth = (box.width - gutter) / 7
    const xInset = gutter + dayColumnWidth * 3 + dayColumnWidth / 2 // middle of column index 3

    await dragTimeRange(page, weekView, xInset, 96, 192)

    const popover = page.getByTestId('quick-create-popover')
    await expect(popover).toBeVisible()
    const titleInput = popover.getByPlaceholder('New Event')
    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(popover).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  // H5 — past-date events must persist
  test('day view: creating an event on a past date persists', async ({ page }) => {
    const title = `MarqueePast-${Date.now()}`

    await openCalendar(page)
    await switchView(page, 'Day')

    // Move 3 days into the past.
    const prevButton = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: /previous|prev/i })
      .first()
    for (let i = 0; i < 3; i++) await prevButton.click()

    const dayView = page.getByTestId('calendar-view')
    await expect(dayView).toBeVisible()
    await scrollGridToTop(dayView)
    await page.waitForTimeout(100)

    await dragTimeRange(page, dayView, 140, 96, 192)

    const popover = page.getByTestId('quick-create-popover')
    await expect(popover).toBeVisible()
    const titleInput = popover.getByPlaceholder('New Event')
    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(popover).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  // Stress: 3 sequential creates back-to-back must all land.
  // This catches intermittent races that only appear under rapid repeat use
  // (the user's "sometimes works, sometimes doesn't" complaint).
  test('day view: three sequential marquee-create cycles all persist', async ({ page }) => {
    await openCalendar(page)
    await switchView(page, 'Day')

    const dayView = page.getByTestId('calendar-view')
    await expect(dayView).toBeVisible()
    await scrollGridToTop(dayView)
    await page.waitForTimeout(100)

    const stamp = Date.now()
    const titles = [`StressA-${stamp}`, `StressB-${stamp}`, `StressC-${stamp}`]

    // Three back-to-back drags on non-overlapping hour ranges.
    const ranges: Array<[number, number]> = [
      [96, 192], // 01:00 – 02:00
      [288, 384], // 03:00 – 04:00
      [480, 576] // 05:00 – 06:00
    ]

    for (let i = 0; i < titles.length; i++) {
      const [yStart, yEnd] = ranges[i]
      await dragTimeRange(page, dayView, 140, yStart, yEnd)

      const popover = page.getByTestId('quick-create-popover')
      await expect(popover).toBeVisible()
      const titleInput = popover.getByPlaceholder('New Event')
      await titleInput.fill(titles[i])
      await titleInput.press('Enter')
      await expect(popover).toBeHidden()
    }

    for (const t of titles) {
      const chip = page
        .getByTestId('calendar-page')
        .getByRole('button', { name: new RegExp(t) })
        .first()
      await expect(chip).toBeVisible()
    }
  })
})
