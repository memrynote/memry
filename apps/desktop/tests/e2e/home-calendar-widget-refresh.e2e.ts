// @ts-nocheck - E2E specs run outside the app tsconfig; `page`/`electronApp` are fixture-typed.
/**
 * Home calendar widget refresh (#1911)
 *
 * The reported bug: create an event and the Home board's calendar widget never
 * shows it, "there is no refresh happening". Root cause was that the only
 * listener for the main process's `calendar:changed` broadcast lived inside
 * `useCalendarRange`, so it existed only while something rendering a range was
 * mounted -- and a tab group mounts only its active tab. A change that landed
 * while the Home board sat in a background tab reached nobody, and the board's
 * cached range was still inside its 30s `staleTime` when the tab came back, so
 * react-query served the cache. `useCalendarChangeEvents` now runs once in
 * App.tsx and outlives every tab switch.
 *
 * Each case asserts the widget catches up with NO page reload and NO relaunch.
 * A reload would refetch everything and prove nothing.
 *
 * Widget facts (widgets/index.ts + calendar-widget.tsx):
 * - Registered as type `calendar`, defaultLayout 4x4, so its size tier is M.
 * - Rows render as <li data-testid="calendar-event"> containing the title.
 * - The body filters out `visualType === 'task'`, so a seeded task never shows.
 * - The range is the local calendar date pinned to UTC hours, so events must
 *   be seeded inside it.
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding,
  setOpenPagesInNewTab
} from './utils/electron-helpers'

const SEL = {
  homePage: '[data-testid="home-page"]',
  grid: '.home-grid',
  widget: '[data-testid="widget"]',
  calendarWidget: '[data-testid="widget"][data-widget-type="calendar"]',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  calendarPage: '[data-testid="calendar-page"]',
  // The sidebar row, not the widget footer's "Open Calendar" link. A
  // role+name lookup for "Calendar" matches both once the widget is on the
  // board, and Playwright's strict mode rejects the pair.
  calendarNav: '[data-tour="nav-calendar"]',
  tab: '[role="tab"][data-group-id]'
}

async function ready(page) {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
  await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
  // Default board seeds two widgets; wait for it before touching the gallery.
  await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
}

/** Add the calendar widget through the gallery dropdown and wait for its body. */
async function addCalendarWidget(page) {
  const trigger = page.locator(SEL.addWidgetTrigger)
  await expect(trigger).toBeVisible({ timeout: 20000 })
  await trigger.click()
  await expect(page.locator(SEL.gallery)).toBeVisible({ timeout: 20000 })
  await page.locator(`${SEL.galleryItem}[data-widget-type="calendar"]`).click()
  await expect(page.locator(SEL.gallery)).toBeHidden({ timeout: 20000 })
  await expect(page.locator(SEL.calendarWidget)).toBeVisible({ timeout: 20000 })
}

/** Rows inside the Home calendar widget. */
function calendarRows(page) {
  return page.locator(SEL.calendarWidget).locator('[data-testid="calendar-event"]')
}

/**
 * An ISO instant inside the widget's range, which is the LOCAL calendar date
 * pinned to UTC hours (`todayCalendarRange`). Building the day from UTC
 * components instead would seed the wrong day whenever the local date and the
 * UTC date disagree, e.g. any evening east of UTC. Clamped away from both
 * edges so the event cannot land on the neighbouring day.
 */
function todayUtcAt(hour: number): string {
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`
}

/** Create a Memry event through the same IPC the calendar UI calls. */
async function createEvent(page, title: string, hour: number): Promise<void> {
  const result = await page.evaluate(
    async ({ title, startAt, endAt }) =>
      window.api.calendar.createEvent({
        title,
        startAt,
        endAt,
        timezone: 'UTC',
        isAllDay: false
      }),
    { title, startAt: todayUtcAt(hour), endAt: todayUtcAt(hour + 1) }
  )
  expect(result.success).toBe(true)
}

test.describe('Home calendar widget picks up new events (#1911)', () => {
  test('an event created while the board is the active tab appears without a refresh', async ({
    page
  }) => {
    await ready(page)
    await addCalendarWidget(page)

    const title = `Widget refresh event ${Date.now()}`
    await expect(calendarRows(page).filter({ hasText: title })).toHaveCount(0)

    await createEvent(page, title, 12)

    // No reload: the broadcast alone has to bring the row in.
    await expect(calendarRows(page).filter({ hasText: title })).toHaveCount(1, { timeout: 15000 })
  })

  test('an event created on the Calendar tab appears when the board comes back', async ({
    page
  }) => {
    await ready(page)
    await addCalendarWidget(page)

    // Keep the Home tab alive in the strip so switching away only unmounts it.
    await setOpenPagesInNewTab(page, true)

    const title = `Background board event ${Date.now()}`
    await expect(calendarRows(page).filter({ hasText: title })).toHaveCount(0)

    await page.locator(SEL.calendarNav).click()
    await expect(page.locator(SEL.calendarPage)).toBeVisible({ timeout: 20000 })
    // The board is now a background tab, so its widgets are unmounted.
    await expect(page.locator(SEL.calendarWidget)).toHaveCount(0)

    await createEvent(page, title, 13)

    await page.locator(SEL.tab).filter({ hasText: 'Home' }).first().click()
    await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })

    // Still no reload. Before the fix this row never arrived: nothing listening
    // marked the board's range invalid, and it was still inside its staleTime.
    await expect(calendarRows(page).filter({ hasText: title })).toHaveCount(1, { timeout: 15000 })
  })

  test('an event that arrives from a calendar provider while the board is open appears', async ({
    page,
    electronApp
  }) => {
    await ready(page)
    await addCalendarWidget(page)

    // `seedCalendarProjection` writes the rows a Google sync writes: a
    // `calendar_sources` account row plus a `calendar_external_events` row. It
    // does not announce them, so the broadcast is sent separately, exactly as
    // `emitCalendarChanged` does from the provider sync service. Together that is
    // the provider path as the renderer experiences it, with no network.
    const importedTitle = 'Imported customer call'
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`

    await expect(calendarRows(page).filter({ hasText: importedTitle })).toHaveCount(0)

    await electronApp.evaluate(
      async ({ BrowserWindow }, input) => {
        const hooks = globalThis.__memryTestHooks
        if (!hooks) throw new Error('Memry test hooks are not registered')
        await hooks.seedCalendarProjection(input)

        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          win.webContents.send('calendar:changed', {
            entityType: 'calendar_external_event',
            id: 'calendar-e2e-external'
          })
        }
      },
      {
        day,
        importedTitle,
        taskTitle: 'Due launch brief',
        reminderTitle: 'Medication reminder',
        snoozeTitle: 'Review investor email'
      }
    )

    await expect(calendarRows(page).filter({ hasText: importedTitle })).toHaveCount(1, {
      timeout: 15000
    })
  })
})
