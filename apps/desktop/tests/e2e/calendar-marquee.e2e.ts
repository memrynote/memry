import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

test.describe('Calendar — marquee quick-create', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('drag selection on day view creates an event after typing a title', async ({ page }) => {
    const title = `MarqueeE2E-${Date.now()}`

    await page.getByRole('button', { name: 'Calendar' }).click()
    await expect(page.getByTestId('calendar-page')).toBeVisible()

    await page
      .getByTestId('calendar-page')
      .getByRole('button', { name: 'Day', exact: true })
      .click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'day')

    const grid = page.getByTestId('day-time-grid')
    await expect(grid).toBeVisible()

    // Scroll the grid's overflow parent to top so absolute grid coords
    // (HOUR_HEIGHT=96 per hour) align with viewport y.
    await grid.evaluate((el) => {
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
    await page.waitForTimeout(100)

    const box = await grid.boundingBox()
    if (!box) throw new Error('day-time-grid has no bounding box')

    // Drag from 01:00 (y = 96) to 02:00 (y = 192) — safely within the first
    // screen of the grid regardless of viewport size.
    const x = box.x + box.width / 2
    const yStart = box.y + 96
    const yEnd = box.y + 192

    await page.mouse.move(x, yStart)
    await page.mouse.down()
    await page.mouse.move(x, yEnd, { steps: 8 })
    await page.mouse.up()

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
})
