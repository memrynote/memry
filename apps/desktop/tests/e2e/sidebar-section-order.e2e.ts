/**
 * The sidebar's sections (Collections, Projects, Bookmarks, Canvases, Tags) used
 * to render in hand-written source order — nothing a user could change (#1645).
 *
 * This runs against the real app because the reorder only exists end to end: the
 * handle is a dnd-kit draggable registered on the app-level DndContext shared
 * with tasks and the folder tree, the drop target is decided by that context's
 * custom collision detection, and the resulting order round-trips through
 * general settings. A jsdom test can prove the order is read; only the app can
 * prove the drag reaches it and survives a reload.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding
} from './utils/electron-helpers'

const SECTION = '[data-testid="sidebar-section-sortable"]'
const HANDLE = '[data-testid="sidebar-section-drag"]'

const DEFAULT_ORDER = ['collections', 'projects', 'bookmarks', 'canvases', 'tags']

async function ready(page: Page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
  await page.locator(SECTION).first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function sectionOrder(page: Page): Promise<string[]> {
  return page.$$eval(SECTION, (nodes) =>
    nodes.map((node) => node.getAttribute('data-section-id') ?? '')
  )
}

/** What the app persisted, independent of what is on screen. */
async function savedOrder(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const preload = (window as unknown as { api: Record<string, any> }).api
    return (await preload.settings.getSidebarSectionOrder()) as string[]
  })
}

/** Wait until an element stops moving, then hand back its box. */
async function settleBox(locator: ReturnType<Page['locator']>): Promise<void> {
  let previous = ''
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox()
        const current = box ? `${Math.round(box.x)},${Math.round(box.y)}` : ''
        const stable = current !== '' && current === previous
        previous = current
        return stable
      },
      { timeout: 10_000, intervals: [150] }
    )
    .toBe(true)
}

/**
 * Drag one section's handle onto another section's header.
 *
 * dnd-kit needs a press, movement past the app context's 8px activation
 * distance, and intermediate moves before the drop registers.
 */
async function dragSectionOnto(page: Page, fromId: string, toId: string): Promise<void> {
  const handle = page.locator(`${SECTION}[data-section-id="${fromId}"] ${HANDLE}`)
  const target = page.locator(`${SECTION}[data-section-id="${toId}"]`)

  // Expanding a section animates its height (grid-template-rows), so a box read
  // mid-animation aims the press at whatever row is passing through.
  await settleBox(handle)

  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error(`dragSectionOnto: no box for ${fromId} → ${toId}`)

  const startX = from.x + from.width / 2
  const startY = from.y + from.height / 2
  const endY = to.y + Math.min(to.height, 24) / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + (endY > startY ? 12 : -12), { steps: 5 })
  await page.mouse.move(startX, endY, { steps: 10 })
  await page.mouse.up()
}

test.describe('Sidebar section order', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('a fresh vault renders the default order and saves nothing', async ({ page }) => {
    expect(await sectionOrder(page)).toEqual(DEFAULT_ORDER)
    // Empty, not the default list: an untouched sidebar must keep following the
    // build's default so a section added later lands in its intended slot.
    expect(await savedOrder(page)).toEqual([])
  })

  test('dragging Tags above Collections reorders and persists it', async ({ page }) => {
    await dragSectionOnto(page, 'tags', 'collections')

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))

    await expect
      .poll(async () => (await savedOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))

    // The order lives in settings, not in component state.
    await page.reload()
    await ready(page)
    expect(await sectionOrder(page)).toEqual([
      'tags',
      'collections',
      'projects',
      'bookmarks',
      'canvases'
    ])
  })

  test('a saved order missing a section still renders it in its default slot', async ({ page }) => {
    // What an order written by an older build looks like: no Canvases, plus an
    // id this build has never heard of.
    await page.evaluate(async () => {
      const preload = (window as unknown as { api: Record<string, any> }).api
      await preload.settings.setSidebarSectionOrder([
        'shelves',
        'tags',
        'collections',
        'projects',
        'bookmarks'
      ])
    })

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))
  })

  test('a drag still lands with the sections expanded over project rows', async ({ page }) => {
    // The sidebar shares its DndContext with the tasks board, and project rows
    // are the one other dnd-kit droppable inside the sidebar itself. With the
    // Projects section open, a section dragged past those rows must still
    // resolve to a section — closest-center over every droppable on screen
    // happily answers "project" instead, and the drop then does nothing.
    await page.evaluate(async () => {
      const api = (window as unknown as { api: Record<string, any> }).api
      for (const name of Array.from({ length: 12 }, (_, i) => `Project ${i + 1}`)) {
        const result = await api.tasks.createProject({
          name,
          description: 'Sidebar section order E2E',
          color: '#6366f1',
          icon: 'FolderKanban',
          statuses: [
            { name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
            { name: 'Done', color: '#10b981', type: 'done', order: 1 }
          ]
        })
        if (!result.success) throw new Error(result.error ?? 'project create failed')
      }
    })

    await page.reload()
    await ready(page)

    await page.getByRole('button', { name: /^Projects section/ }).click()
    await expect(page.getByText('Project 12')).toBeVisible()

    await dragSectionOnto(page, 'tags', 'collections')

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))
  })

  test('a section dropped back on itself leaves the order alone', async ({ page }) => {
    await dragSectionOnto(page, 'bookmarks', 'bookmarks')

    expect(await sectionOrder(page)).toEqual(DEFAULT_ORDER)
    expect(await savedOrder(page)).toEqual([])
  })
})
