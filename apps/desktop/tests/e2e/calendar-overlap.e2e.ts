import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

interface OverlapSeedInput {
  day: string
  importedTitle: string
  taskTitle: string
  reminderTitle: string
  snoozeTitle: string
  overlapMemryTitle: string
}

function toIsoDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function seedOverlap(
  electronApp: Parameters<typeof test>[0]['electronApp'],
  input: OverlapSeedInput
): Promise<void> {
  await electronApp.evaluate(async (_ctx, payload) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: { seedCalendarProjection(d: OverlapSeedInput): Promise<void> }
      }
    ).__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    await hooks.seedCalendarProjection(payload)
  }, input)
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByTestId('calendar-page')).toBeVisible()
}

async function switchView(page: Page, name: 'Day' | 'Week'): Promise<void> {
  await page.getByTestId('calendar-page').getByRole('button', { name, exact: true }).click()
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-view', name.toLowerCase())
}

test.describe('Calendar — overlapping events layout', () => {
  const seed: OverlapSeedInput = {
    day: toIsoDay(new Date()),
    importedTitle: 'Imported customer call',
    taskTitle: 'Due launch brief',
    reminderTitle: 'Medication reminder',
    snoozeTitle: 'Review investor email',
    overlapMemryTitle: 'Prep for customer call'
  }

  test.beforeEach(async ({ page, electronApp }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await seedOverlap(electronApp, seed)
  })

  test('overlapping chips render side-by-side in day view with distinct hit regions', async ({
    page
  }) => {
    // #given — seed creates a 9:00-10:00 Memry event and a 9:30-10:30 external event.
    // They overlap at 9:30-10:00. Pre-fix, both rendered full-width and the later DOM
    // element captured all clicks. Post-fix, each lands in its own lane.
    await openCalendar(page)
    await switchView(page, 'Day')

    const grid = page.getByTestId('day-time-grid')
    const memryChip = grid.getByRole('button', { name: new RegExp(seed.overlapMemryTitle) })
    const externalChip = grid.getByRole('button', { name: new RegExp(seed.importedTitle) })

    await expect(memryChip).toBeVisible()
    await expect(externalChip).toBeVisible()

    // Scroll to 9 AM so both chips are fully in viewport (Playwright's
    // boundingBox reports viewport-relative coords, not document coords).
    await memryChip.scrollIntoViewIfNeeded()

    // #when — measure each chip's bounding box
    const memryBox = await memryChip.boundingBox()
    const externalBox = await externalChip.boundingBox()
    if (!memryBox || !externalBox) {
      throw new Error('expected both chips to have bounding boxes')
    }

    // #then — chips occupy disjoint horizontal regions (lane packing)
    const memryRight = memryBox.x + memryBox.width
    const externalRight = externalBox.x + externalBox.width
    const disjoint = memryRight <= externalBox.x || externalRight <= memryBox.x
    if (!disjoint) {
      throw new Error(
        `expected disjoint horizontal regions, got memry ${JSON.stringify(memryBox)} vs external ${JSON.stringify(externalBox)}`
      )
    }

    // #then — the external chip receives a real click without force/dispatch tricks.
    // Pre-fix, clicking the external chip would be intercepted by the Memry chip (or
    // vice versa) since both spanned the same horizontal range.
    await externalChip.click()
    await expect(page.getByTestId('promote-external-dialog')).toBeVisible()
  })

  test('overlapping chips render side-by-side in week view with distinct hit regions', async ({
    page
  }) => {
    // #given — same seed, week view
    await openCalendar(page)
    await switchView(page, 'Week')

    const weekGrid = page.getByTestId('calendar-week-scroll')
    const memryChip = weekGrid
      .getByRole('button', { name: new RegExp(seed.overlapMemryTitle) })
      .first()
    const externalChip = weekGrid
      .getByRole('button', { name: new RegExp(seed.importedTitle) })
      .first()

    await expect(memryChip).toBeVisible()
    await expect(externalChip).toBeVisible()
    await memryChip.scrollIntoViewIfNeeded()

    // #when
    const memryBox = await memryChip.boundingBox()
    const externalBox = await externalChip.boundingBox()
    if (!memryBox || !externalBox) {
      throw new Error('expected both chips to have bounding boxes')
    }

    // #then — chips occupy disjoint horizontal regions even in a week column
    const memryRight = memryBox.x + memryBox.width
    const externalRight = externalBox.x + externalBox.width
    const disjoint = memryRight <= externalBox.x || externalRight <= memryBox.x
    if (!disjoint) {
      throw new Error(
        `expected disjoint horizontal regions, got memry ${JSON.stringify(memryBox)} vs external ${JSON.stringify(externalBox)}`
      )
    }
  })
})
