// @ts-nocheck - E2E tests in development, some vars intentionally unused
/**
 * Home Dashboard E2E Tests
 *
 * Covers the Home Dashboard board engine (Plan 1): default landing, first-run
 * seed, board switcher (select + create), add/remove/resize/reorder widgets,
 * layout persistence (window reload + full app restart), multi-board isolation,
 * and edge cases.
 *
 * Groups: A (landing/seed), B (switcher/multi-board), C (add widget),
 * D (frame controls), E (layout persistence), H (edge cases).
 *
 * COVERAGE BOUNDARY: every test runs against a FRESH temp vault (fixtures), so
 * the migration-skip bug we fixed (0032 journal `when` ordering) is NOT
 * reproducible here — it only manifests on a vault already migrated to 0031.
 * That case is covered by the unit test
 * `apps/desktop/src/main/database/migrate-journal.test.ts`. Do not attempt it.
 *
 * Widget-specific behavior (Recently edited / Bookmarks content + ordering)
 * lives in `home-widget-recently-edited.e2e.ts` and `home-widget-bookmarks.e2e.ts`.
 */

import { test, expect } from './fixtures'
import {
  waitForAppReady,
  waitForVaultReady,
  dismissFirstRunOnboarding
} from './utils/electron-helpers'
import { launchElectronWithWindow, destroyElectronApp } from './utils/electron-lifecycle'

// ============================================================================
// Selectors (Phase 1 shipped these — rely on them verbatim)
// ============================================================================

const SEL = {
  homePage: '[data-testid="home-page"]',
  // The RGL board switcher is a dropdown: a trigger button + per-board menu items
  // (with a Check on the active one) + a "new board" item. There are no longer
  // persistent visible chips with data-active.
  switcher: '[data-testid="home-layout-switcher"]',
  boardItem: '[data-testid="home-layout-item"]',
  newBoard: '[data-testid="home-layout-new"]',
  // The board renders as a react-grid-layout grid (className "home-grid"); the
  // grid no longer carries a board-grid testid.
  grid: '.home-grid',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  // The add-widget trigger renders unconditionally (no edit mode). The gallery is
  // a dropdown menu, so it closes after each item select.
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  widget: '[data-testid="widget"]',
  // Per-widget controls now live in a dropdown opened by the widget-menu button;
  // the menu exposes a destructive "Remove" item.
  widgetMenu: '[data-testid="widget-menu"]',
  // Home tab in the main tab strip (regular-tab.tsx sets nav-home on the home tab)
  homeTab: '[data-testid="nav-home"]',
  // Board manager: a dialog opened from the switcher's "Manage boards" item. It owns
  // rename (inline field), reorder (dnd-kit drag handle) and delete.
  manageBoards: '[data-testid="home-layout-manage"]',
  manager: '[data-testid="board-manager"]',
  managerRow: '[data-testid="board-manager-row"]',
  managerDrag: '[data-testid="board-manager-drag"]',
  managerRename: '[data-testid="board-manager-rename"]',
  managerNameInput: '[data-testid="board-manager-name-input"]',
  managerDelete: '[data-testid="board-manager-delete"]'
}

// i18n English strings (packages/i18n/src/locales/en/common.json → "home")
const REMOVE_LABEL = 'Remove'

// ============================================================================
// Helpers
// ============================================================================

async function ready(page) {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
}

/** Wait until the first-run seed has produced the default "Home" board + grid. */
async function waitForSeed(page) {
  await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
  // Default board renders its two default widgets inside the RGL grid.
  await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
}

/**
 * Open the add-widget dropdown so its gallery is reachable. The trigger renders
 * unconditionally (no edit mode). Idempotent: opens only if closed. The gallery
 * is a DropdownMenu, so it closes after each item select — callers that add more
 * than one widget must re-open between selects.
 */
async function openWidgetGallery(page) {
  const trigger = page.locator(SEL.addWidgetTrigger)
  await expect(trigger).toBeVisible({ timeout: 20000 })
  if (await page.locator(SEL.gallery).isVisible()) return
  // Dismiss any half-closed menu so the trigger click reliably opens a fresh one.
  await page.keyboard.press('Escape')
  await expect(page.locator(SEL.gallery))
    .toBeHidden()
    .catch(() => {})
  await trigger.click()
  await expect(page.locator(SEL.gallery)).toBeVisible({ timeout: 20000 })
}

/** Add one widget of `type` via the gallery dropdown (re-opens it each call). */
async function addWidget(page, type) {
  await openWidgetGallery(page)
  await page.locator(`${SEL.galleryItem}[data-widget-type="${type}"]`).click()
  // The gallery closes on select; wait for it to unmount before the next open.
  await expect(page.locator(SEL.gallery)).toBeHidden({ timeout: 20000 })
}

function widgetsByType(page, type) {
  return page.locator(`${SEL.grid} ${SEL.widget}[data-widget-type="${type}"]`)
}

/** Remove a widget via its per-card dropdown menu (open menu → "Remove"). */
async function removeWidget(page, card) {
  await card.locator(SEL.widgetMenu).click()
  await page.getByRole('menuitem', { name: REMOVE_LABEL }).click()
}

/** Read board ids/order straight from the data DB via the IPC surface. */
async function listBoards(page) {
  return page.evaluate(() => window.api.homePages.list())
}

/**
 * Set a widget's grid height through the homePages API (the RGL resize grip has
 * no test hook). Size is a derived tier (sizeTier: h<=2 → S, h<=4 → M, else L),
 * so writing h is how a test changes the content-density tier. Caller reloads.
 */
async function setWidgetHeightById(page, widgetId, h) {
  await page.evaluate(
    async ({ widgetId, h }) => {
      const boards = await window.api.homePages.list()
      const board = boards.find((b) => b.widgets.some((w) => w.id === widgetId))
      if (!board) throw new Error(`no board with widget ${widgetId}`)
      const widgets = board.widgets.map((w) => (w.id === widgetId ? { ...w, h } : w))
      await window.api.homePages.update({ id: board.id, widgets })
    },
    { widgetId, h }
  )
}

/** Move a widget to a new top-left cell via the homePages API. Caller reloads. */
async function setWidgetPositionById(page, widgetId, x, y) {
  await page.evaluate(
    async ({ widgetId, x, y }) => {
      const boards = await window.api.homePages.list()
      const board = boards.find((b) => b.widgets.some((w) => w.id === widgetId))
      if (!board) throw new Error(`no board with widget ${widgetId}`)
      const widgets = board.widgets.map((w) => (w.id === widgetId ? { ...w, x, y } : w))
      await window.api.homePages.update({ id: board.id, widgets })
    },
    { widgetId, x, y }
  )
}

/** Map of widget id → {x,y} from the active board's persisted model. */
async function widgetCoords(page, boardId) {
  return page.evaluate(async (boardId) => {
    const boards = await window.api.homePages.list()
    const board = boards.find((b) => b.id === boardId)
    const out = {}
    for (const w of board?.widgets ?? []) out[w.id] = { x: w.x, y: w.y }
    return out
  }, boardId)
}

/** The board-switcher dropdown menu items (one per board), in DOM order. */
function boardItems(page) {
  return page.locator(SEL.boardItem)
}

/**
 * Open the board switcher dropdown from a known-closed state. Radix animates the
 * menu in/out, so a half-open menu can leave items "resolved but not stable"; we
 * dismiss anything open, then click the trigger and wait for the items to settle.
 */
async function openSwitcher(page) {
  await page.keyboard.press('Escape')
  await expect(boardItems(page).first())
    .toHaveCount(0)
    .catch(() => {})
  await page.locator(SEL.switcher).click()
  await expect(boardItems(page).first()).toBeVisible({ timeout: 20000 })
}

/** Create a new board via the switcher dropdown. */
async function createBoard(page) {
  await openSwitcher(page)
  await page.locator(SEL.newBoard).click()
  // The menu closes on select; wait for it to fully unmount before the next open.
  await expect(boardItems(page).first()).toBeHidden({ timeout: 20000 })
}

/** Activate the board with the given id via the switcher dropdown. */
async function selectBoard(page, boardId) {
  await openSwitcher(page)
  const item = page.locator(`${SEL.boardItem}[data-board-id="${boardId}"]`)
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(boardItems(page).first()).toBeHidden({ timeout: 20000 })
}

/** Open the board manager dialog from the switcher dropdown. */
async function openBoardManager(page) {
  await openSwitcher(page)
  await page.locator(SEL.manageBoards).click()
  await expect(page.locator(SEL.manager)).toBeVisible({ timeout: 20000 })
  await expect(page.locator(SEL.managerRow).first()).toBeVisible({ timeout: 20000 })
}

/** Close the board manager dialog. */
async function closeBoardManager(page) {
  await page.keyboard.press('Escape')
  await expect(page.locator(SEL.manager)).toBeHidden({ timeout: 20000 })
}

/** Board ids ordered by their persisted position. */
async function boardIdsInOrder(page) {
  const boards = await listBoards(page)
  return [...boards].sort((a, b) => a.position - b.position).map((b) => b.id)
}

/** The id of the currently active board, read from the data DB + localStorage. */
async function activeBoardId(page) {
  return page.evaluate(() => {
    const stored = localStorage.getItem('memry-home-active-board')
    return stored
  })
}

// ============================================================================
// Group A — Landing & first-run seed
// ============================================================================

test.describe('Home Dashboard — A: landing & seed', () => {
  test('A1: fresh vault lands on Home without manual navigation', async ({ page }) => {
    await ready(page)
    await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
  })

  test('A2: default board named "Home" auto-seeded exactly once', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    // The switcher trigger shows the active board name; the dropdown lists one
    // item per board.
    await expect(page.locator(SEL.switcher)).toContainText('Home', { timeout: 20000 })
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(1, { timeout: 20000 })
    await expect(boardItems(page).first()).toContainText('Home')
  })

  test('A3: seeded board renders the two default widgets', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)
  })

  test('A4: seed runs once — reload keeps one board and two widgets', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.reload()
    await ready(page)

    await expect(page.locator(SEL.switcher)).toContainText('Home', { timeout: 20000 })
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(1, { timeout: 20000 })
    await page.keyboard.press('Escape')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
  })

  test('A5: Home is a singleton tab — re-opening focuses the existing tab', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // Exactly one Home tab to start.
    await expect(page.locator(SEL.homeTab)).toHaveCount(1)

    // Attempt to open Home again. nav-home is the Home tab itself; clicking it
    // focuses (never duplicates). SINGLETON_TAB_TYPES includes 'home', and the
    // OPEN_TAB reducer focuses any existing singleton instead of adding one.
    await page.locator(SEL.homeTab).first().click()
    await expect(page.locator(SEL.homeTab)).toHaveCount(1)
    await expect(page.locator(SEL.homePage)).toBeVisible()
  })
})

// ============================================================================
// Group B — Board switcher & multi-board
// ============================================================================

test.describe('Home Dashboard — B: board switcher & multi-board', () => {
  test('B1: one menu item per board, ordered by position', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // Seed has one board; add a second so ordering is observable.
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    const boards = await listBoards(page)
    const ordered = [...boards].sort((a, b) => a.position - b.position)
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(2, { timeout: 20000 })
    const itemIds = await boardItems(page).evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-board-id'))
    )
    expect(itemIds).toEqual(ordered.map((b) => b.id))
  })

  test('B2: creating a board increases the board count by one', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const before = (await listBoards(page)).length
    await createBoard(page)
    await expect
      .poll(async () => (await listBoards(page)).length, { timeout: 20000 })
      .toBe(before + 1)
  })

  test('B3: a new board is empty (zero widgets)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    // Activate the freshly created board (the non-"Home" one).
    const boards = await listBoards(page)
    const newBoard = boards.find((b) => b.name !== 'Home')
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })

    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
  })

  test('B4: selecting a different board swaps the grid to its widgets', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    const boards = await listBoards(page)
    const homeBoard = boards.find((b) => b.name === 'Home')
    const newBoard = boards.find((b) => b.name !== 'Home')

    // Switch to the new (empty) board → no widgets.
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })

    // Switch back to Home — its two widgets return.
    await selectBoard(page, homeBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText('Home', { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
  })

  test('B5: active board persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    const boards = await listBoards(page)
    const newBoard = boards.find((b) => b.name !== 'Home')
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })

    await page.reload()
    await ready(page)

    // Active board persists via localStorage → switcher still shows it, empty grid.
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })
    expect(await activeBoardId(page)).toBe(newBoard.id)
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
  })

  test('B6: active-board fallback — cleared localStorage activates first board', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    // Activate board 2 (position 1), then wipe the persisted active-board key.
    const boards = await listBoards(page)
    const newBoard = boards.find((b) => b.name !== 'Home')
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })

    await page.evaluate(() => localStorage.removeItem('memry-home-active-board'))
    await page.reload()
    await ready(page)

    // Fallback resolves to boards[0] (position 0) — the seeded "Home" board.
    const first = [...(await listBoards(page))].sort((a, b) => a.position - b.position)[0]
    await expect(page.locator(SEL.switcher)).toContainText(first.name, { timeout: 20000 })
  })

  test('B7: renaming a board from the manager persists and re-labels the switcher', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)

    const [board] = await listBoards(page)
    await openBoardManager(page)

    const row = page.locator(`${SEL.managerRow}[data-board-id="${board.id}"]`)
    await row.locator(SEL.managerRename).click()

    // The field is opened from a Radix menu selection; a menu restores focus to its
    // trigger when its content unmounts (~150ms later), which would blur the field
    // and commit an unchanged name. jsdom cannot see that — assert focus survives.
    const input = page.locator(SEL.managerNameInput)
    await expect(input).toBeFocused({ timeout: 20000 })
    await page.waitForTimeout(600)
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    await input.fill('Planning')
    await page.keyboard.press('Enter')

    await expect
      .poll(async () => (await listBoards(page)).find((b) => b.id === board.id)?.name, {
        timeout: 20000
      })
      .toBe('Planning')

    await closeBoardManager(page)
    await expect(page.locator(SEL.switcher)).toContainText('Planning', { timeout: 20000 })

    // And it survives a reload — the rename went to the DB, not just local state.
    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.switcher)).toContainText('Planning', { timeout: 20000 })
  })

  test('B8: dragging a row in the manager reorders the boards', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    const before = await boardIdsInOrder(page)
    await openBoardManager(page)

    const handle = page
      .locator(`${SEL.managerRow}[data-board-id="${before[1]}"] ${SEL.managerDrag}`)
      .first()
    const target = page.locator(`${SEL.managerRow}[data-board-id="${before[0]}"]`).first()
    const from = await handle.boundingBox()
    const to = await target.boundingBox()

    // dnd-kit needs a pointer press, movement past its 6px activation distance, and
    // intermediate moves before the drop lands.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 5 })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 4, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(async () => (await boardIdsInOrder(page)).join(','), { timeout: 20000 })
      .toBe([before[1], before[0]].join(','))

    await closeBoardManager(page)
    await page.reload()
    await ready(page)
    expect((await boardIdsInOrder(page)).join(',')).toBe([before[1], before[0]].join(','))
  })

  test('B9: deleting a board from the manager removes it', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)

    const boards = await listBoards(page)
    const doomed = boards.find((b) => b.name !== 'Home')
    await openBoardManager(page)
    await page
      .locator(`${SEL.managerRow}[data-board-id="${doomed.id}"] ${SEL.managerDelete}`)
      .click()

    await expect
      .poll(async () => (await listBoards(page)).map((b) => b.id), { timeout: 20000 })
      .not.toContain(doomed.id)

    // The last remaining board cannot be deleted.
    await expect(page.locator(SEL.managerDelete)).toBeDisabled({ timeout: 20000 })
  })
})

// ============================================================================
// Group C — Add widget (gallery)
// ============================================================================

test.describe('Home Dashboard — C: add widget', () => {
  test('C1: gallery lists one item per registered widget type', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await openWidgetGallery(page)

    await expect(page.locator(SEL.gallery)).toBeVisible()
    await expect(
      page.locator(`${SEL.galleryItem}[data-widget-type="recently-edited"]`)
    ).toHaveCount(1)
    await expect(page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`)).toHaveCount(1)
  })

  test('C2: clicking a gallery item adds a widget of that type', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await addWidget(page, 'bookmarks')
    // Seed already had one bookmarks widget → now two.
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, { timeout: 20000 })
  })

  test('C3: adding the same type twice yields two cards (instances allowed)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // The gallery is a dropdown that closes after each select, so re-open it for
    // the second add (addWidget re-opens the gallery each call).
    await addWidget(page, 'recently-edited')
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, { timeout: 20000 })
    await addWidget(page, 'recently-edited')
    // Seed had one → +2 → three recently-edited cards.
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(3, { timeout: 20000 })
  })

  test('C4: an added widget persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await addWidget(page, 'bookmarks')
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, { timeout: 20000 })

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, { timeout: 20000 })
  })
})

// ============================================================================
// Group D — Widget frame controls
// ============================================================================

test.describe('Home Dashboard — D: widget frame controls', () => {
  test('D1: remove deletes the card and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const bookmarks = widgetsByType(page, 'bookmarks')
    await expect(bookmarks).toHaveCount(1)
    const removedId = await bookmarks.first().getAttribute('data-widget-id')

    await removeWidget(page, bookmarks.first())
    await expect(bookmarks).toHaveCount(0, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })

    await page.reload()
    await ready(page)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${removedId}"]`)).toHaveCount(0)
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
  })

  test('D2: resize updates the derived size tier and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const recent = widgetsByType(page, 'recently-edited').first()
    const widgetId = await recent.getAttribute('data-widget-id')
    // Default span (h=4) → M tier.
    await expect(recent).toHaveAttribute('data-widget-size', 'M')

    // Size is now derived from the grid span (sizeTier). Shrink to h=2 → S tier
    // through the board model (the RGL resize grip has no test hook), then reload.
    await setWidgetHeightById(page, widgetId, 2)
    await page.reload()
    await ready(page)
    const sCard = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)
    await expect(sCard).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })
  })

  test('D3: size tier is derived from the grid span (S/M/L by height)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const recent = widgetsByType(page, 'recently-edited').first()
    const widgetId = await recent.getAttribute('data-widget-id')
    const card = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)

    // sizeTier: h<=2 → S, h<=4 → M, else L.
    await setWidgetHeightById(page, widgetId, 2)
    await page.reload()
    await ready(page)
    await expect(card).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })

    await setWidgetHeightById(page, widgetId, 4)
    await page.reload()
    await ready(page)
    await expect(card).toHaveAttribute('data-widget-size', 'M', { timeout: 20000 })

    await setWidgetHeightById(page, widgetId, 6)
    await page.reload()
    await ready(page)
    await expect(card).toHaveAttribute('data-widget-size', 'L', { timeout: 20000 })
  })

  test('D4: a moved widget keeps its grid position across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const cards = page.locator(`${SEL.grid} ${SEL.widget}`)
    await expect(cards).toHaveCount(2)

    const boards = await listBoards(page)
    const boardId = boards[0].id
    const movedId = await cards.first().getAttribute('data-widget-id')

    // react-grid-layout positions cards by x/y (not DOM order), so move the first
    // card to a distinct column and assert the persisted x survives reload. (y is
    // subject to RGL's vertical compaction, so only the column is stable.)
    await setWidgetPositionById(page, movedId, 4, 8)

    await page.reload()
    await ready(page)
    await expect(cards).toHaveCount(2, { timeout: 20000 })
    await expect
      .poll(async () => (await widgetCoords(page, boardId))[movedId]?.x, { timeout: 20000 })
      .toBe(4)
  })
})

// ============================================================================
// Group E — Layout persistence (integration)
// ============================================================================

test.describe('Home Dashboard — E: layout persistence', () => {
  test('E1: composed layout (add/resize/reorder/remove) restored after reload', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)

    // Add a 2nd recently-edited.
    await addWidget(page, 'recently-edited')
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, { timeout: 20000 })

    // Shrink the bookmarks widget to the S tier (h=2).
    const bookmarkId = await widgetsByType(page, 'bookmarks').first().getAttribute('data-widget-id')
    await setWidgetHeightById(page, bookmarkId, 2)
    await page.reload()
    await ready(page)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${bookmarkId}"]`)).toHaveAttribute(
      'data-widget-size',
      'S',
      { timeout: 20000 }
    )

    // Move one recently-edited card to a distinct column.
    const recentId = await widgetsByType(page, 'recently-edited')
      .first()
      .getAttribute('data-widget-id')
    await setWidgetPositionById(page, recentId, 4, 10)

    const boardId = (await listBoards(page))[0].id

    await page.reload()
    await ready(page)
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(3, { timeout: 20000 })
    // The composed layout (sizes + positions) is restored from the persisted model.
    // (y compacts vertically under RGL, so assert the stable column.)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${bookmarkId}"]`)).toHaveAttribute(
      'data-widget-size',
      'S',
      { timeout: 20000 }
    )
    await expect
      .poll(async () => (await widgetCoords(page, boardId))[recentId]?.x, { timeout: 20000 })
      .toBe(4)
  })

  test('E2: composed layout restored after full app restart (from data.db)', async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(120_000)
    await ready(page)
    await waitForSeed(page)

    // Compose: add a 2nd recently-edited, shrink bookmarks to the S tier (h=2).
    await addWidget(page, 'recently-edited')
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, { timeout: 20000 })
    const bookmarkId = await widgetsByType(page, 'bookmarks').first().getAttribute('data-widget-id')
    await setWidgetHeightById(page, bookmarkId, 2)
    await page.reload()
    await ready(page)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${bookmarkId}"]`)).toHaveAttribute(
      'data-widget-size',
      'S',
      { timeout: 20000 }
    )

    // Capture the persisted board state (type + grid span) from the data DB.
    const boardsBefore = await listBoards(page)
    expect(boardsBefore).toHaveLength(1)
    const widgetsBefore = boardsBefore[0].widgets.map((w) => ({ type: w.type, w: w.w, h: w.h }))

    // Full restart: relaunch a brand-new Electron app against the SAME vault dir
    // (new userData → localStorage is gone; layout must come from data.db).
    const relaunched = await launchElectronWithWindow({ testVaultPath })
    try {
      const page2 = relaunched.page
      await ready(page2)
      await expect(page2.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })

      // No re-seed (still one board) and the composed widget set is intact.
      await expect(page2.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(3, { timeout: 20000 })

      const boardsAfter = await page2.evaluate(() => window.api.homePages.list())
      expect(boardsAfter).toHaveLength(1)
      const widgetsAfter = boardsAfter[0].widgets.map((w) => ({ type: w.type, w: w.w, h: w.h }))
      expect(widgetsAfter).toEqual(widgetsBefore)

      // And rendered: 2 recently-edited + 1 bookmarks(S tier).
      await expect(
        page2.locator(`${SEL.grid} ${SEL.widget}[data-widget-type="recently-edited"]`)
      ).toHaveCount(2, { timeout: 20000 })
      const bm = page2.locator(`${SEL.grid} ${SEL.widget}[data-widget-type="bookmarks"]`)
      await expect(bm).toHaveCount(1)
      await expect(bm.first()).toHaveAttribute('data-widget-size', 'S')
    } finally {
      const dirs = [relaunched.userDataDir]
      if (relaunched.resolvedUserDataDir !== relaunched.userDataDir) {
        dirs.push(relaunched.resolvedUserDataDir)
      }
      await destroyElectronApp(relaunched.app, dirs)
    }
  })

  test('E3: per-board isolation — each board keeps its own layout', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const homeBoard = (await listBoards(page)).find((b) => b.name === 'Home')

    // Board 2: create, then give it a single bookmarks widget.
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)
    const newBoard = (await listBoards(page)).find((b) => b.name !== 'Home')
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
    await addWidget(page, 'bookmarks')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    // Back to board 1 (Home): still the original 2 default widgets.
    await selectBoard(page, homeBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText('Home', { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    // Back to board 2: still exactly its single bookmarks widget.
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(0)
  })
})

// ============================================================================
// Group H — Edge cases / robustness
// ============================================================================

test.describe('Home Dashboard — H: edge cases', () => {
  test('H1: unknown widget type is skipped without crashing the board', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const boards = await listBoards(page)
    const board = boards[0]
    const known = board.widgets.filter((w) => w.type === 'recently-edited')[0]
    expect(known).toBeTruthy()

    // Write a board whose widgets include an unknown type alongside a known one.
    // WidgetInstanceSchema now requires integer x/y/w/h (no size field); the board
    // renders a graceful "unknown" placeholder card for the unregistered type.
    await page.evaluate(
      ({ id, known }) =>
        window.api.homePages.update({
          id,
          widgets: [
            { id: 'broken-1', type: 'does-not-exist', x: 0, y: 0, w: 4, h: 4, config: {} },
            known
          ]
        }),
      { id: board.id, known }
    )

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })

    // The board did not crash: the unknown widget renders a graceful placeholder
    // frame (with the widget-unknown body) AND the known widget still renders.
    const broken = page.locator(`${SEL.widget}[data-widget-id="broken-1"]`)
    await expect(broken).toHaveCount(1, { timeout: 20000 })
    await expect(broken.locator('[data-testid="widget-unknown"]')).toHaveCount(1)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
  })

  test('H2: an empty board renders an empty grid with a usable gallery', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // Create + activate an empty board.
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, { timeout: 20000 }).toBe(2)
    const newBoard = (await listBoards(page)).find((b) => b.name !== 'Home')
    await selectBoard(page, newBoard.id)
    await expect(page.locator(SEL.switcher)).toContainText(newBoard.name, { timeout: 20000 })

    // Grid present but empty; gallery still usable (clicking adds a widget).
    // An empty grid collapses to 0 height, so it is attached-but-not-"visible"
    // per Playwright's visibility heuristic — assert presence, not paint.
    await expect(page.locator(SEL.grid)).toBeAttached()
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
    await addWidget(page, 'bookmarks')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
  })

  test('H3: rapid reloads after seed never create more than one Home board', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    for (let i = 0; i < 3; i += 1) {
      await page.reload()
      await ready(page)
      await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
    }

    // Settle, then assert exactly one "Home" board survives.
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`).first()).toBeVisible({ timeout: 20000 })
    const boards = await listBoards(page)
    expect(boards.filter((b) => b.name === 'Home')).toHaveLength(1)
  })
})
