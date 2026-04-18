import { test, expect, type Page } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

async function scrollCalendarToTop(page: Page): Promise<void> {
  const dayView = page.getByTestId('calendar-view')
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
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
}

async function switchView(page: Page, name: 'Day' | 'Week'): Promise<void> {
  await page.getByTestId('calendar-page').getByRole('button', { name, exact: true }).click()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', name.toLowerCase())
}

async function dragSelection(page: Page, columnXOffset: number, durationHours = 1): Promise<void> {
  const dayView = page.getByTestId('calendar-view')
  await expect(dayView).toBeVisible()
  await scrollCalendarToTop(page)

  const box = await dayView.boundingBox()
  if (!box) throw new Error('calendar view has no bounding box')

  // Grid is 96 px per hour (HOUR_HEIGHT). Drag relative to that.
  const x = box.x + columnXOffset
  const yStart = box.y + 96
  const yEnd = box.y + 96 + 96 * durationHours

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

  test('drag + Enter creates event (day view)', async ({ page }) => {
    const title = `MarqueeEnter-${Date.now()}`
    await openCalendar(page)
    await switchView(page, 'Day')

    await dragSelection(page, 140)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()

    const titleInput = dialog.getByPlaceholder('New Event')
    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(dialog).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  test('drag + Save-button click creates event (day view) — regression', async ({ page }) => {
    const title = `MarqueeSaveClick-${Date.now()}`
    await openCalendar(page)
    await switchView(page, 'Day')

    await dragSelection(page, 140)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()

    await dialog.getByPlaceholder('New Event').fill(title)
    await dialog.getByTestId('quick-create-save').click()

    await expect(dialog).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  test('drag + Save-button click creates event (week view) — regression', async ({ page }) => {
    const title = `MarqueeWeekSave-${Date.now()}`
    await openCalendar(page)
    await switchView(page, 'Week')

    // Week grid is horizontally laid out across 7 columns. Pick a column
    // that is clearly not the first so we catch column-index regressions.
    await dragSelection(page, 280)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()

    await dialog.getByPlaceholder('New Event').fill(title)
    await dialog.getByTestId('quick-create-save').click()

    await expect(dialog).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()
  })

  test('created event renders with height matching dragged duration — regression', async ({
    page
  }) => {
    const title = `MarqueeDuration-${Date.now()}`
    await openCalendar(page)
    await switchView(page, 'Day')

    // Drag 2 hours. HOUR_HEIGHT = 96 px, so the chip should render ≈ 192 px tall.
    await dragSelection(page, 140, 2)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()

    await dialog.getByPlaceholder('New Event').fill(title)
    await dialog.getByTestId('quick-create-save').click()

    await expect(dialog).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()

    // Chip wrapper is positioned absolutely with height equal to durationMinutes × 1.6 px.
    // 2 hours = 120 min × 1.6 = 192 px. Allow some tolerance for rounding. The bug
    // produced 24 px (the hard-coded minimum for < 15-min events) regardless of duration.
    const chipBox = await chip.boundingBox()
    if (!chipBox) throw new Error('chip has no bounding box')
    expect(chipBox.height).toBeGreaterThanOrEqual(150)
    expect(chipBox.height).toBeLessThanOrEqual(210)
  })

  test('created event renders with correct duration in week view — regression', async ({
    page
  }) => {
    const title = `MarqueeWeekDuration-${Date.now()}`
    await openCalendar(page)
    await switchView(page, 'Week')

    await dragSelection(page, 280, 2)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()

    await dialog.getByPlaceholder('New Event').fill(title)
    await dialog.getByTestId('quick-create-save').click()

    await expect(dialog).toBeHidden()
    const chip = page
      .getByTestId('calendar-page')
      .getByRole('button', { name: new RegExp(title) })
      .first()
    await expect(chip).toBeVisible()

    const chipBox = await chip.boundingBox()
    if (!chipBox) throw new Error('chip has no bounding box')
    // Chip element itself — not just its positioned wrapper — must fill the slot.
    // Regression guard: pre-fix, the chip had natural content height (~24 px)
    // inside a 192-px wrapper, so the user saw a 15-min-looking block.
    expect(chipBox.height).toBeGreaterThanOrEqual(150)
    expect(chipBox.height).toBeLessThanOrEqual(210)
  })

  test('Cancel button dismisses without creating', async ({ page }) => {
    await openCalendar(page)
    await switchView(page, 'Day')
    await dragSelection(page, 140)

    const dialog = page.getByTestId('quick-create-popover')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('New Event').fill('Discarded')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await expect(dialog).toBeHidden()
    const chip = page.getByTestId('calendar-page').getByRole('button', { name: /Discarded/ })
    await expect(chip).toHaveCount(0)
  })
})
