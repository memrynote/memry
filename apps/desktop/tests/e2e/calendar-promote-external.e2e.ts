/**
 * M2 promote-external-event flow.
 *
 * Clicking an externally-owned Google event chip in Memry should open a
 * confirmation dialog ("Edit this event in Memry?"). Confirming the dialog
 * must create a linked calendar_events row, archive the mirror, and open the
 * edit popover so the user can immediately make changes.
 *
 * This file covers the user-visible path end-to-end; internal correctness
 * (binding ownership mode, mirror archival, idempotency) is unit-tested in
 * src/main/calendar/promote-external-event.test.ts.
 */
import type { ElectronApplication } from '@playwright/test'
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

async function seedProjection(
  electronApp: ElectronApplication,
  input: SeededCalendarData
): Promise<void> {
  await electronApp.evaluate(async (_ctx, payload) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: { seedCalendarProjection(d: SeededCalendarData): Promise<void> }
      }
    ).__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    await hooks.seedCalendarProjection(payload)
  }, input)
}

test.describe('Calendar — M2 promote external event', () => {
  test.beforeEach(async ({ page, electronApp }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await seedProjection(electronApp, getSeededCalendarData())

    await page.getByRole('button', { name: 'Calendar' }).click()
    const calendarPage = page.getByTestId('calendar-page')
    await expect(calendarPage).toBeVisible()
    await calendarPage.getByRole('button', { name: 'Day', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', 'day')
  })

  test('#given an imported Google event #when the user clicks it #then the promote-external confirmation dialog appears', async ({
    page
  }) => {
    const { importedTitle } = getSeededCalendarData()
    const calendarPage = page.getByTestId('calendar-page')

    // #when: click the imported event chip
    const chip = calendarPage.getByRole('button', { name: new RegExp(importedTitle) }).first()
    await expect(chip).toBeVisible()
    await chip.click()

    // #then: promote confirmation dialog appears with copy from the M2 design
    const dialog = page.getByTestId('promote-external-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Edit this event in Memry?')).toBeVisible()
    await expect(dialog.getByText(/create a linked copy/i)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Edit in Memry/i })).toBeVisible()
  })

  test('#given the promote dialog is open #when the user cancels #then the dialog closes and no edit popover opens', async ({
    page
  }) => {
    const { importedTitle } = getSeededCalendarData()
    const calendarPage = page.getByTestId('calendar-page')

    await calendarPage
      .getByRole('button', { name: new RegExp(importedTitle) })
      .first()
      .click()
    const dialog = page.getByTestId('promote-external-dialog')
    await expect(dialog).toBeVisible()

    // #when
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // #then
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('event-edit-popover')).toHaveCount(0)

    // The original imported chip is still shown — nothing was promoted
    await expect(
      calendarPage.getByRole('button', { name: new RegExp(importedTitle) }).first()
    ).toBeVisible()
  })

  test('#given the user confirms the promote dialog #when promote succeeds #then the edit popover opens pre-populated from the external event', async ({
    page
  }) => {
    const { importedTitle } = getSeededCalendarData()
    const calendarPage = page.getByTestId('calendar-page')

    await calendarPage
      .getByRole('button', { name: new RegExp(importedTitle) })
      .first()
      .click()
    const dialog = page.getByTestId('promote-external-dialog')
    await expect(dialog).toBeVisible()

    // #when
    await dialog.getByRole('button', { name: /Edit in Memry/i }).click()

    // #then: dialog gone, edit popover visible, title input carries the external event's title
    await expect(dialog).toBeHidden()
    const popover = page.getByTestId('event-edit-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByPlaceholder('New Event')).toHaveValue(importedTitle)
  })

  test('#given promote succeeded and the popover is open #when the user renames and saves #then the new title appears on the calendar', async ({
    page
  }) => {
    const { importedTitle } = getSeededCalendarData()
    const calendarPage = page.getByTestId('calendar-page')
    const renamed = `Promoted-${Date.now()}`

    await calendarPage
      .getByRole('button', { name: new RegExp(importedTitle) })
      .first()
      .click()
    await page
      .getByTestId('promote-external-dialog')
      .getByRole('button', { name: /Edit in Memry/i })
      .click()

    const popover = page.getByTestId('event-edit-popover')
    await expect(popover).toBeVisible()
    const titleInput = popover.getByPlaceholder('New Event')
    await titleInput.fill(renamed)

    // #when
    await popover.getByTestId('event-edit-save').click()

    // #then: popover closes, the renamed chip is visible
    await expect(popover).toBeHidden()
    await expect(
      calendarPage.getByRole('button', { name: new RegExp(renamed) }).first()
    ).toBeVisible()
  })

  test('#given promoteConfirmDismissed=true in settings #when the user clicks an imported event #then the dialog is skipped and the edit popover opens directly', async ({
    page,
    electronApp
  }) => {
    const { importedTitle } = getSeededCalendarData()

    // #given
    await electronApp.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: unknown
        }
      ).__memryTestHooks
      if (!api) throw new Error('hooks missing')
    })
    // Flip the "don't ask again" flag via the renderer settings IPC (the same
    // channel the dialog checkbox uses).
    await page.evaluate(async () => {
      await window.api.settings.setCalendarGoogleSettings({ promoteConfirmDismissed: true })
    })

    const calendarPage = page.getByTestId('calendar-page')

    // #when
    await calendarPage
      .getByRole('button', { name: new RegExp(importedTitle) })
      .first()
      .click()

    // #then: no dialog, popover opens straight away with the external title
    await expect(page.getByTestId('promote-external-dialog')).toHaveCount(0)
    const popover = page.getByTestId('event-edit-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByPlaceholder('New Event')).toHaveValue(importedTitle)
  })
})
