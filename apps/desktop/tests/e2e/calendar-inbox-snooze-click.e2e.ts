import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

interface SeededCalendarData {
  day: string
  importedTitle: string
  taskTitle: string
  reminderTitle: string
  snoozeTitle: string
}

function toIsoDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getSeededCalendarData(): SeededCalendarData {
  const today = new Date()
  return {
    day: toIsoDay(today),
    importedTitle: 'Imported customer call',
    taskTitle: 'Due launch brief',
    reminderTitle: 'Medication reminder',
    snoozeTitle: 'Review investor email'
  }
}

async function seedAndOpenDay(
  electronApp: Parameters<typeof test>[0]['electronApp'],
  page: Parameters<typeof test>[0]['page']
): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)

  await electronApp.evaluate(async (_context, input) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: {
          seedCalendarProjection(input: SeededCalendarData): Promise<void>
        }
      }
    ).__memryTestHooks

    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }

    await hooks.seedCalendarProjection(input)
  }, getSeededCalendarData())

  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
  await page.getByTestId('calendar-page').getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'day')
}

test.describe('Calendar: snoozed inbox item click', () => {
  test('opens popover with three actions and dismisses on Escape', async ({
    electronApp,
    page
  }) => {
    await seedAndOpenDay(electronApp, page)

    const calendarPage = page.getByTestId('calendar-page')
    const chip = calendarPage.getByRole('button', { name: /Review investor email/i }).first()
    await expect(chip).toBeVisible()
    await chip.click()

    const popover = page.getByTestId('calendar-inbox-snooze-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('button', { name: /open in inbox/i })).toBeVisible()
    await expect(popover.getByRole('button', { name: /unsnooze now/i })).toBeVisible()
    await expect(popover.getByRole('button', { name: /reschedule/i })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })

  test('Unsnooze now removes the chip from the calendar', async ({ electronApp, page }) => {
    await seedAndOpenDay(electronApp, page)

    const calendarPage = page.getByTestId('calendar-page')
    const chip = calendarPage.getByRole('button', { name: /Review investor email/i }).first()
    await chip.click()

    const popover = page.getByTestId('calendar-inbox-snooze-popover')
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: /unsnooze now/i }).click()

    await expect(popover).toBeHidden()
    await expect(calendarPage.getByRole('button', { name: /Review investor email/i })).toHaveCount(
      0,
      { timeout: 5_000 }
    )
  })

  test('Open in inbox opens the detail panel for the snoozed item', async ({
    electronApp,
    page
  }) => {
    await seedAndOpenDay(electronApp, page)

    const calendarPage = page.getByTestId('calendar-page')
    const chip = calendarPage.getByRole('button', { name: /Review investor email/i }).first()
    await chip.click()

    const popover = page.getByTestId('calendar-inbox-snooze-popover')
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: /open in inbox/i }).click()

    // Inbox is a singleton tab; activating it tears down the calendar surface
    // (the active group's content area renders the inbox tab instead).
    await expect(calendarPage).toBeHidden()

    // The inbox detail panel should be open and showing the snoozed item.
    const detailPanel = page.getByTestId('inbox-detail-panel')
    await expect(detailPanel).toHaveAttribute('data-state', 'open')
    await expect(detailPanel.getByText('Review investor email').first()).toBeVisible()
  })
})
