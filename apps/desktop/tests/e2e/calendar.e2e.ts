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
  const day = toIsoDay(today)
  const importedTitle = 'Imported customer call'
  const taskTitle = 'Due launch brief'
  const reminderTitle = 'Medication reminder'
  const snoozeTitle = 'Review investor email'

  return {
    day,
    importedTitle,
    taskTitle,
    reminderTitle,
    snoozeTitle
  }
}

async function openCalendarWorkspace(page: Parameters<typeof test>[0]['page']): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
}

test.describe('Calendar milestone e2e', () => {
  test.beforeEach(async ({ page, electronApp }) => {
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
  })

  test('opens the Calendar workspace, switches views, renders projected items, and creates/edits a Memry event', async ({
    page
  }) => {
    const eventTitle = `Calendar QA Event ${Date.now()}`
    const renamedEventTitle = `${eventTitle} Renamed`
    const calendarPage = page.getByTestId('calendar-page')

    await openCalendarWorkspace(page)

    await calendarPage.getByRole('button', { name: 'Day', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'day')
    await expect(
      calendarPage.getByRole('button', { name: /Imported customer call/i }).first()
    ).toBeVisible()
    await expect(
      calendarPage.getByRole('button', { name: /Due launch brief/i }).first()
    ).toBeVisible()
    await expect(
      calendarPage.getByRole('button', { name: /Medication reminder/i }).first()
    ).toBeVisible()
    await expect(
      calendarPage.getByRole('button', { name: /Review investor email/i }).first()
    ).toBeVisible()

    await calendarPage.getByRole('button', { name: 'Week', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'week')

    await calendarPage.getByRole('button', { name: 'Month', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'month')

    await calendarPage.getByRole('button', { name: 'Year', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'year')

    await calendarPage.getByRole('button', { name: 'Day', exact: true }).click()
    await calendarPage.getByRole('button', { name: 'New Event' }).click()
    await expect(page.getByRole('heading', { name: 'New Event' })).toBeVisible()

    await page.getByLabel('Title').fill(eventTitle)
    await page.getByRole('button', { name: 'Create Event' }).click()
    await expect(
      calendarPage.getByRole('button', { name: new RegExp(eventTitle) }).first()
    ).toBeVisible()

    await calendarPage
      .getByRole('button', { name: new RegExp(eventTitle) })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Edit Event' })).toBeVisible()
    await page.getByLabel('Title').fill(renamedEventTitle)
    await page.getByRole('button', { name: 'Save Changes' }).click()
    await expect(
      calendarPage.getByRole('button', { name: new RegExp(renamedEventTitle) }).first()
    ).toBeVisible()
  })

  test('shows the same projection in the global journal day panel', async ({ page }) => {
    await openCalendarWorkspace(page)

    await page.getByRole('button', { name: 'Day Panel' }).click()
    const dayPanel = page.locator('[data-slot="day-panel-inner"]')
    const scheduleHeading = dayPanel.getByText('Schedule')
    await scheduleHeading.scrollIntoViewIfNeeded()

    await expect(scheduleHeading).toBeVisible()
    await expect(dayPanel.getByText('Imported customer call')).toBeVisible()
    await expect(dayPanel.getByText('Review investor email')).toBeVisible()
  })
})
