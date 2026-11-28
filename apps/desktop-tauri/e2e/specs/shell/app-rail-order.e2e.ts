// The app rail's page icons (Home, Inbox, Journal, ...) can be dragged into a new order, which
// persists per vault in `sidebar.railOrder`. Ported from Electron's `app-rail-order.e2e.ts`
// (#3547 30h).
//
// Runs against the real app because the rail shares the app-level DndContext with the sidebar's
// Projects list, and that is where the first version broke: the default Inbox project is a
// sortable with id `inbox`, the same id the rail used for its Inbox icon. dnd-kit keys
// draggables and droppables by id, so the rail picked up the project row, icons jumped away,
// and drops sprang back.
import { waitForAppReady } from '../../harness/app-helpers'
import { appReady } from '../../harness/app-ready'
import { PointerDrag } from '../../harness/pointer-drag'
import type { Page } from '../../harness/pw-compat/page'
import { test as base, expect } from '../../harness/test'

/** Each case starts on a ready app, as Electron's `beforeEach` did. */
const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await ready(page)
    await use(page)
  }
})

const RAIL_ITEM = '[data-rail-page]'

async function ready(page: Page): Promise<void> {
  await appReady(page)
  await waitForAppReady(page)
  await page.locator(RAIL_ITEM).first().waitFor({ state: 'visible', timeout: 30_000 })
}

function railOrder(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector)).map(
        (node) => node.getAttribute('data-rail-page') ?? ''
      ),
    RAIL_ITEM
  )
}

/** What the app persisted, independent of what is on screen. */
function savedRailOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => window.api.settings.getSidebarRailOrder())
}

/** Mount the Projects list, whose Inbox project row is a sortable with id `inbox`. */
async function openProjects(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: /^Projects section/ })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
}

/** Press on one rail icon, move past the 8px activation distance, and drop at `endY`. */
async function dragRailIcon(page: Page, fromPage: string, endY: number): Promise<void> {
  const from = await page.locator(`${RAIL_ITEM}[data-rail-page="${fromPage}"]`).boundingBox()
  if (!from) throw new Error(`dragRailIcon: no box for ${fromPage}`)

  const x = from.x + from.width / 2
  const startY = from.y + from.height / 2

  const drag = await PointerDrag.press(page, { x, y: startY })
  await drag.glide({ x, y: startY + (endY > startY ? 12 : -12) }, 5)
  await drag.glide({ x, y: endY }, 12)
  await drag.release()
}

async function centerY(page: Page, railPage: string): Promise<number> {
  const box = await page.locator(`${RAIL_ITEM}[data-rail-page="${railPage}"]`).boundingBox()
  if (!box) throw new Error(`centerY: no box for ${railPage}`)
  return box.y + box.height / 2
}

function moved(order: string[], item: string, toIndex: number): string[] {
  const next = order.filter((id) => id !== item)
  next.splice(toIndex, 0, item)
  return next
}

test.describe('App rail order', () => {
  test('Inbox drags below the last icon with the Projects list open, and persists', async ({
    page
  }) => {
    await openProjects(page)
    const initial = await railOrder(page)
    expect(initial).toContain('inbox')
    expect(await savedRailOrder(page)).toEqual([])

    const last = initial[initial.length - 1]
    await dragRailIcon(page, 'inbox', await centerY(page, last))

    const expected = moved(initial, 'inbox', initial.length - 1)
    await expect
      .poll(async () => (await railOrder(page)).join(','), { timeout: 20_000 })
      .toBe(expected.join(','))
    await expect
      .poll(async () => (await savedRailOrder(page)).join(','), { timeout: 20_000 })
      .toBe(expected.join(','))

    await page.reload()
    await ready(page)
    expect(await railOrder(page)).toEqual(expected)
  })

  test('the last icon drags to the top', async ({ page }) => {
    await openProjects(page)
    const initial = await railOrder(page)
    const last = initial[initial.length - 1]

    await dragRailIcon(page, last, await centerY(page, initial[0]))

    await expect
      .poll(async () => (await railOrder(page)).join(','), { timeout: 20_000 })
      .toBe(moved(initial, last, 0).join(','))
  })

  test('the carried icon stays in the rail when the pointer runs into the dock', async ({
    page
  }) => {
    await openProjects(page)
    const initial = await railOrder(page)
    const lastBox = await page
      .locator(`${RAIL_ITEM}[data-rail-page="${initial[initial.length - 1]}"]`)
      .boundingBox()
    const dockBox = await page.getByTestId('app-rail-dock').boundingBox()
    const homeBox = await page.locator(`${RAIL_ITEM}[data-rail-page="home"]`).boundingBox()
    if (!lastBox || !dockBox || !homeBox) throw new Error('no box')

    const x = homeBox.x + homeBox.width / 2
    const startY = homeBox.y + homeBox.height / 2

    const drag = await PointerDrag.press(page, { x, y: startY })
    await drag.glide({ x, y: startY + 12 }, 5)
    await drag.glide({ x, y: dockBox.y + dockBox.height / 2 }, 15)

    const carried = await page.locator(`${RAIL_ITEM}[data-rail-page="home"]`).boundingBox()
    await drag.release()

    if (!carried) throw new Error('no carried box')
    // Clamped to the last slot, nowhere near the dock.
    expect(Math.round(carried.y + carried.height)).toBeLessThanOrEqual(
      Math.round(lastBox.y + lastBox.height) + 1
    )

    await expect
      .poll(async () => (await railOrder(page)).join(','), { timeout: 20_000 })
      .toBe(moved(initial, 'home', initial.length - 1).join(','))
  })

  test('an icon dropped back on itself leaves the order alone', async ({ page }) => {
    const initial = await railOrder(page)
    await dragRailIcon(page, 'home', await centerY(page, 'home'))

    expect(await railOrder(page)).toEqual(initial)
    expect(await savedRailOrder(page)).toEqual([])
  })
})
