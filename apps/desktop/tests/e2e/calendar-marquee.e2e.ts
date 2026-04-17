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

    const dayView = page.getByTestId('calendar-view')
    await expect(dayView).toBeVisible()

    // Scroll the grid's overflow parent to top so absolute grid coords
    // (HOUR_HEIGHT=96 per hour) align with viewport y.
    await dayView.evaluate((el) => {
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

    const box = await dayView.boundingBox()
    if (!box) throw new Error('calendar day view has no bounding box')

    // Drag inside the main day grid area. Use a fixed inset from the left edge
    // of the visible day view instead of the internal grid test id, which is
    // not always present early enough under CI rendering pressure.
    const x = box.x + 140
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
