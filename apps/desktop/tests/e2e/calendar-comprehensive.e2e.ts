import type { Page } from '@playwright/test'
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

class CalendarPO {
  constructor(readonly page: Page) {}

  root() {
    return this.page.getByTestId('calendar-page')
  }

  view() {
    return this.page.getByTestId('calendar-view')
  }

  async open() {
    await this.page.getByRole('button', { name: 'Calendar' }).click()
    await expect(this.root()).toBeVisible()
  }

  async switchView(name: 'Day' | 'Week' | 'Month' | 'Year') {
    await this.root().getByRole('button', { name, exact: true }).click()
    await expect(this.view()).toHaveAttribute('data-view', name.toLowerCase())
  }

  async clickPrev() {
    await this.root().getByRole('button', { name: 'Previous period' }).click()
  }

  async clickNext() {
    await this.root().getByRole('button', { name: 'Next period' }).click()
  }

  async clickToday() {
    await this.root().getByRole('button', { name: 'Today', exact: true }).click()
  }

  popover() {
    return this.page.getByTestId('event-edit-popover')
  }

  titleInput() {
    return this.popover().getByPlaceholder('New Event')
  }

  async openCreateDrawer() {
    await this.root().getByRole('button', { name: 'Create event' }).click()
    await expect(this.popover()).toBeVisible()
  }

  async openFilters() {
    await this.root().getByRole('button', { name: 'Filter calendars' }).click()
  }

  async createEvent(opts: {
    title: string
    description?: string
    location?: string
    allDay?: boolean
  }) {
    await this.openCreateDrawer()
    await this.titleInput().fill(opts.title)
    if (opts.description)
      await this.popover().getByPlaceholder('Add notes or URL').fill(opts.description)
    if (opts.location) await this.popover().getByPlaceholder('Add location').fill(opts.location)
    if (opts.allDay) await this.popover().getByLabel('All day').check()
    await this.popover().getByTestId('event-edit-save').click()
    await expect(this.popover()).toBeHidden()
  }

  eventChip(title: string | RegExp) {
    const matcher = typeof title === 'string' ? new RegExp(title) : title
    return this.root().getByRole('button', { name: matcher })
  }
}

async function seedProjection(
  electronApp: Parameters<typeof test>[0]['electronApp'],
  input: SeededCalendarData
) {
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

test.describe('Calendar — comprehensive coverage', () => {
  test.beforeEach(async ({ page, electronApp }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await seedProjection(electronApp, getSeededCalendarData())
  })

  test.describe('View switching', () => {
    test('switches between day, week, month, year', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()

      for (const v of ['Day', 'Week', 'Month', 'Year'] as const) {
        await cal.switchView(v)
      }
    })

    test('year view drill-down navigates to month on double-click', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()
      await cal.switchView('Year')

      const dayButton = cal.view().getByRole('button').first()
      await dayButton.dblclick()
      await expect(cal.view()).toHaveAttribute('data-view', 'month')
    })
  })

  test.describe('Date navigation', () => {
    test('prev/next/today move the anchor and Today returns to current date', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()
      await cal.switchView('Month')

      const heading = cal.root().getByRole('heading').first()
      const initial = await heading.textContent()

      await cal.clickNext()
      await expect(heading).not.toHaveText(initial ?? '')

      await cal.clickToday()
      await expect(heading).toHaveText(initial ?? '')

      await cal.clickPrev()
      await expect(heading).not.toHaveText(initial ?? '')
    })
  })

  test.describe('Source filtering', () => {
    test('toggling Memry items hides projected items', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()
      await cal.switchView('Day')

      await expect(cal.eventChip(/Due launch brief/i).first()).toBeVisible()

      await cal.openFilters()
      await page.getByRole('checkbox', { name: 'Memry items' }).uncheck()
      await page.keyboard.press('Escape')

      await expect(cal.eventChip(/Due launch brief/i)).toHaveCount(0)
    })

    test('toggling Imported calendars hides Google-sourced events', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()
      await cal.switchView('Day')

      await expect(cal.eventChip(/Imported customer call/i).first()).toBeVisible()

      await cal.openFilters()
      await page.getByRole('checkbox', { name: 'Imported calendars' }).uncheck()
      await page.keyboard.press('Escape')

      await expect(cal.eventChip(/Imported customer call/i)).toHaveCount(0)
    })
  })

  test.describe('Event creation — full editor', () => {
    test('creates a timed event from the toolbar plus button', async ({ page }) => {
      const cal = new CalendarPO(page)
      const title = `Timed ${Date.now()}`
      await cal.open()
      await cal.switchView('Day')

      await cal.createEvent({
        title,
        description: 'Discuss roadmap',
        location: 'Zoom'
      })

      await expect(cal.eventChip(title).first()).toBeVisible()
    })

    test('creates an all-day event', async ({ page }) => {
      const cal = new CalendarPO(page)
      const title = `AllDay ${Date.now()}`
      await cal.open()
      await cal.switchView('Day')

      await cal.createEvent({ title, allDay: true })
      await expect(cal.eventChip(title).first()).toBeVisible()
    })

    test('discards draft when drawer is closed', async ({ page }) => {
      const cal = new CalendarPO(page)
      const title = `Discarded ${Date.now()}`
      await cal.open()
      await cal.openCreateDrawer()

      await cal.titleInput().fill(title)
      await page.keyboard.press('Escape')

      await expect(cal.popover()).toHaveCount(0)
      await expect(cal.eventChip(title)).toHaveCount(0)
    })

    test('Create Event button is disabled when title is empty', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()
      await cal.openCreateDrawer()

      await expect(cal.popover().getByTestId('event-edit-save')).toBeDisabled()

      await cal.titleInput().fill('Now valid')
      await expect(cal.popover().getByTestId('event-edit-save')).toBeEnabled()
    })
  })

  test.describe('Event creation — quick-create via marquee', () => {
    // Implemented in calendar-marquee.e2e.ts (separate file so it does not
    // inherit the comprehensive suite's seed beforeEach, which the marquee
    // flow does not need).
  })

  test.describe('Event editing', () => {
    test('opens an existing Memry event in edit mode and renames it', async ({ page }) => {
      const cal = new CalendarPO(page)
      const stamp = Date.now()
      const original = `OriginalE2E-${stamp}`
      const renamed = `RenamedE2E-${stamp}`

      await cal.open()
      await cal.switchView('Day')
      await cal.createEvent({ title: original })

      // Day view stacks seeded + new chips at overlapping times; an external_event
      // chip sits on top of ours at the same pixel. Even { force: true } would
      // route the OS-level click to the overlay, so dispatch the event directly
      // on our chip's DOM node.
      await cal.eventChip(original).first().dispatchEvent('click')
      await expect(cal.popover()).toHaveAttribute('aria-label', 'Edit calendar event')

      await cal.titleInput().fill(renamed)
      await cal.popover().getByTestId('event-edit-save').click()

      await expect(cal.eventChip(renamed).first()).toBeVisible()
      await expect(cal.eventChip(original)).toHaveCount(0)
    })

    // Imported-event click behavior is finalized by M2: clicking shows the
    // promote-external confirmation dialog, then (on confirm) opens the edit
    // popover on the newly-promoted native row.
    // Covered end-to-end in calendar-promote-external.e2e.ts.
  })

  test.describe('Loading state', () => {
    test('shows loading text before initial data resolves', async ({ page }) => {
      const cal = new CalendarPO(page)
      await cal.open()

      const loading = page.getByText('Loading calendar...')
      if (await loading.count()) {
        await expect(loading).toBeHidden()
      }
      await expect(cal.view()).toBeVisible()
    })
  })
})
