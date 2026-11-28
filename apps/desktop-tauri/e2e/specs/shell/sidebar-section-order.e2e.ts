// The sidebar's sections (Collections, Projects, Bookmarks, Canvases, Tags) used to render in
// hand-written source order, nothing a user could change (#1645). Ported from Electron's
// `sidebar-section-order.e2e.ts` (#3547 30h).
//
// This runs against the real app because the reorder only exists end to end: the handle is a
// dnd-kit draggable registered on the app-level DndContext shared with tasks and the folder
// tree, the drop target is decided by that context's custom collision detection, and the
// resulting order round-trips through general settings. A jsdom test can prove the order is
// read; only the app can prove the drag reaches it and survives a reload.
import { waitForAppReady } from '../../harness/app-helpers'
import { appReady } from '../../harness/app-ready'
import { PointerDrag } from '../../harness/pointer-drag'
import { createNote } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test as base, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

/** Each case starts on a ready app, as Electron's `beforeEach` did. */
const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await ready(page)
    await use(page)
  }
})

const SECTION = '[data-testid="sidebar-section-sortable"]'
const HANDLE = '[data-testid="sidebar-section-drag"]'
const GHOST = '[data-testid="sidebar-section-ghost"]'

const DEFAULT_ORDER = ['collections', 'projects', 'bookmarks', 'canvases', 'tags']

async function ready(page: Page): Promise<void> {
  await appReady(page)
  await waitForAppReady(page)
  await page.locator(SECTION).first().waitFor({ state: 'visible', timeout: 30_000 })
}

function sectionOrder(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector)).map(
        (node) => node.getAttribute('data-section-id') ?? ''
      ),
    SECTION
  )
}

/** What the app persisted, independent of what is on screen. */
function savedOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => window.api.settings.getSidebarSectionOrder())
}

/** Wait until an element stops moving. */
async function settleBox(locator: Locator): Promise<void> {
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

/** Press at `start`, move past the app context's 8px activation distance, then glide to `end`. */
async function pressAndCarry(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number
): Promise<PointerDrag> {
  const drag = await PointerDrag.press(page, start)
  await drag.glide({ x: start.x, y: start.y + (end.y > start.y ? 12 : -12) }, 5)
  await drag.glide(end, steps)
  return drag
}

/**
 * Drag one section's handle onto another section's header.
 *
 * dnd-kit needs a press, movement past the activation distance, and intermediate moves before
 * the drop registers.
 */
async function dragSectionOnto(page: Page, fromId: string, toId: string): Promise<void> {
  const handle = page.locator(`${SECTION}[data-section-id="${fromId}"] ${HANDLE}`)
  const target = page.locator(`${SECTION}[data-section-id="${toId}"]`)

  // Expanding a section animates its height (grid-template-rows), so a box read mid-animation
  // aims the press at whatever row is passing through.
  await settleBox(handle)

  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error(`dragSectionOnto: no box for ${fromId} → ${toId}`)

  const startX = from.x + from.width / 2
  const startY = from.y + from.height / 2
  const endY = to.y + Math.min(to.height, 24) / 2

  const drag = await pressAndCarry(page, { x: startX, y: startY }, { x: startX, y: endY }, 10)
  await drag.release()
}

/** How far the given element is currently translated, in px. */
function translateY(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const node = document.querySelector(sel)
    if (!node) throw new Error(`translateY: no element for ${sel}`)
    const transform = getComputedStyle(node).transform
    if (!transform || transform === 'none') return 0
    return Math.round(new DOMMatrixReadOnly(transform).m42)
  }, selector)
}

/** Seed `count` projects and open the Projects section over them. */
async function seedProjects(page: Page, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const created = await invoke<{ success: boolean; error?: string | null }>(
      page,
      'tasks_project_create',
      {
        input: {
          name: `Project ${i}`,
          description: 'Sidebar section order E2E',
          color: '#6366f1',
          icon: 'FolderKanban',
          statuses: [
            { name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
            { name: 'Done', color: '#10b981', type: 'done', order: 1 }
          ]
        }
      }
    )
    if (!created.success) throw new Error(created.error ?? 'project create failed')
  }

  await page.reload()
  await ready(page)
  await page.getByRole('button', { name: /^Projects section/ }).click()
  await expect(page.getByText(`Project ${count}`)).toBeVisible()
}

/** Seed notes and open Collections, so the section is taller than the others. */
async function expandTallCollections(page: Page): Promise<void> {
  for (let i = 1; i <= 12; i++) await createNote(page, { title: `Tall note ${i}`, content: '' })

  await page.reload()
  await ready(page)
  await page.getByRole('button', { name: /^Collections section/ }).click()

  // The point of the seed is height, so height is what to wait for: the tree decides for itself
  // which rows it shows.
  await expect
    .poll(
      async () => {
        const box = await page.locator(`${SECTION}[data-section-id="collections"]`).boundingBox()
        return box ? Math.round(box.height) : 0
      },
      { timeout: 20_000, intervals: [200] }
    )
    .toBeGreaterThan(200)
}

test.describe('Sidebar section order', () => {
  test('a fresh vault renders the default order and saves nothing', async ({ page }) => {
    expect(await sectionOrder(page)).toEqual(DEFAULT_ORDER)
    // Empty, not the default list: an untouched sidebar must keep following the build's default
    // so a section added later lands in its intended slot.
    expect(await savedOrder(page)).toEqual([])
  })

  test('dragging Tags above Collections reorders and persists it', async ({ page }) => {
    await dragSectionOnto(page, 'tags', 'collections')

    const expected = ['tags', 'collections', 'projects', 'bookmarks', 'canvases']
    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(expected.join(','))

    await expect
      .poll(async () => (await savedOrder(page)).join(','), { timeout: 20_000 })
      .toBe(expected.join(','))

    // The order lives in settings, not in component state.
    await page.reload()
    await ready(page)
    expect(await sectionOrder(page)).toEqual(expected)
  })

  test('a saved order missing a section still renders it in its default slot', async ({ page }) => {
    // What an order written by an older build looks like: no Canvases, plus an id this build has
    // never heard of.
    await page.evaluate(() =>
      window.api.settings.setSidebarSectionOrder([
        'shelves',
        'tags',
        'collections',
        'projects',
        'bookmarks'
      ])
    )

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))
  })

  // Needs #5947: the sidebar's Projects list reads `tasksService`, still on the not-ported
  // `window.api.tasks` on feat/tauri-v2, so a project made through `tasks_project_create` is not
  // listed and the seed never shows.
  test.fixme('a drag still lands with the sections expanded over project rows', async ({
    page
  }) => {
    // The sidebar shares its DndContext with the tasks board, and project rows are the one other
    // dnd-kit droppable inside the sidebar itself. With the Projects section open, a section
    // dragged past those rows must still resolve to a section.
    await seedProjects(page, 12)

    await dragSectionOnto(page, 'tags', 'collections')

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['tags', 'collections', 'projects', 'bookmarks', 'canvases'].join(','))
  })

  test('a section dragged to the bottom lands there, however tall it is', async ({ page }) => {
    // Collections is the tallest section once its tree is open, and dragging it down used to get
    // lost among the others and spring back. The pointer is what the user is aiming with.
    await expandTallCollections(page)

    const handle = page.locator(`${SECTION}[data-section-id="collections"] ${HANDLE}`)
    const last = page.locator(`${SECTION}[data-section-id="tags"]`)
    await settleBox(handle)

    const from = await handle.boundingBox()
    const to = await last.boundingBox()
    if (!from || !to) throw new Error('no box')

    const startX = from.x + from.width / 2
    const startY = from.y + from.height / 2

    const drag = await pressAndCarry(
      page,
      { x: startX, y: startY },
      { x: startX, y: to.y + to.height - 2 },
      15
    )
    await drag.release()

    await expect
      .poll(async () => (await sectionOrder(page)).join(','), { timeout: 20_000 })
      .toBe(['projects', 'bookmarks', 'canvases', 'tags', 'collections'].join(','))
  })

  // Needs #5947: the sidebar's Projects list reads `tasksService`, still on the not-ported
  // `window.api.tasks` on feat/tauri-v2, so a project made through `tasks_project_create` is not
  // listed and the seed never shows.
  test.fixme('the dragged label keeps following the pointer over a project row', async ({
    page
  }) => {
    // dnd-kit nulls a sortable's transform the moment `over` is not one of the sortable's own
    // items, and the shared collision detection answers "project" for any drag whose pointer is
    // inside a project row, so mid-drag the section used to snap back to where it started.
    await seedProjects(page, 6)

    const handle = page.locator(`${SECTION}[data-section-id="tags"] ${HANDLE}`)
    await settleBox(handle)
    const from = await handle.boundingBox()
    const row = await page.getByText('Project 3').boundingBox()
    if (!from || !row) throw new Error('no box')

    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const drag = await pressAndCarry(
      page,
      start,
      { x: row.x + row.width / 2, y: row.y + row.height / 2 },
      10
    )

    const translated = await translateY(page, `${SECTION}[data-section-id="tags"] ${GHOST}`)
    await drag.release()

    // It is being held far above where it started, so the label must be drawn there; the section
    // itself never moves.
    expect(translated).toBeLessThan(-20)
  })

  test('the target section shows a drop line and nothing else moves', async ({ page }) => {
    // Sections sliding by the dragged section's own height threw the sidebar around. Only the
    // dragged section moves now; a line marks where it lands.
    const handle = page.locator(`${SECTION}[data-section-id="tags"] ${HANDLE}`)
    await settleBox(handle)
    const from = await handle.boundingBox()
    const target = await page.locator(`${SECTION}[data-section-id="collections"]`).boundingBox()
    if (!from || !target) throw new Error('no box')

    const startX = from.x + from.width / 2
    const start = { x: startX, y: from.y + from.height / 2 }
    const drag = await pressAndCarry(
      page,
      start,
      { x: startX, y: target.y + target.height / 2 },
      10
    )

    // Coming from below, so it lands above Collections.
    await expect(page.locator(`${SECTION}[data-section-id="collections"]`)).toHaveAttribute(
      'data-drop-edge',
      'before'
    )
    expect(await translateY(page, `${SECTION}[data-section-id="collections"]`)).toBe(0)
    expect(await translateY(page, `${SECTION}[data-section-id="projects"]`)).toBe(0)
    expect(await translateY(page, `${SECTION}[data-section-id="bookmarks"]`)).toBe(0)

    await drag.release()

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
