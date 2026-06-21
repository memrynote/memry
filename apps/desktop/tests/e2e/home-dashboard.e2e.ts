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
  switcher: '[data-testid="board-switcher"]',
  chip: '[data-testid="board-chip"]',
  newBoard: '[data-testid="board-new"]',
  grid: '[data-testid="board-grid"]',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  widget: '[data-testid="widget"]',
  // Home tab in the main tab strip (regular-tab.tsx sets nav-home on the home tab)
  homeTab: '[data-testid="nav-home"]'
}

// i18n English strings (packages/i18n/src/locales/en/common.json → "home")
const REMOVE_ARIA = 'Remove widget'
const DRAG_ARIA = 'Drag widget'

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
  await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
  // Default board renders its two default widgets.
  await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
}

function widgetsByType(page, type) {
  return page.locator(`${SEL.grid} ${SEL.widget}[data-widget-type="${type}"]`)
}

/** Remove control for a given widget instance (scoped to the card frame). */
function removeControl(card) {
  return card.locator(`[aria-label="${REMOVE_ARIA}"]`)
}

/** Drag handle for a given widget instance. */
function dragHandle(card) {
  return card.locator(`[aria-label="${DRAG_ARIA}"]`)
}

/** Read board ids/order straight from the data DB via the IPC surface. */
async function listBoards(page) {
  return page.evaluate(() => window.api.homePages.list())
}

/** dnd-kit reorder: manual pointer steps with intermediate moves (dragTo is flaky). */
async function dragWidget(page, sourceCard, targetCard) {
  const handle = dragHandle(sourceCard)
  const src = await handle.boundingBox()
  const dst = await targetCard.boundingBox()
  if (!src || !dst) throw new Error('drag boundingBox unavailable')

  const startX = src.x + src.width / 2
  const startY = src.y + src.height / 2
  const endX = dst.x + dst.width / 2
  const endY = dst.y + dst.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // dnd-kit needs movement before the sensor activates — step in increments.
  const steps = 12
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      startX + ((endX - startX) * i) / steps,
      startY + ((endY - startY) * i) / steps
    )
  }
  // Settle over the target before releasing.
  await page.mouse.move(endX, endY)
  await page.mouse.move(endX, endY)
  await page.mouse.up()
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
    const chips = page.locator(SEL.chip)
    await expect(chips).toHaveCount(1, { timeout: 20000 })
    await expect(chips.first()).toHaveText('Home')
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

    await expect(page.locator(SEL.chip)).toHaveCount(1, { timeout: 20000 })
    await expect(page.locator(SEL.chip).first()).toHaveText('Home')
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
  test('B1: one chip per board, ordered by position', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // Seed has one board; add a second so ordering is observable.
    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })

    const boards = await listBoards(page)
    const ordered = [...boards].sort((a, b) => a.position - b.position)
    const chipIds = await page
      .locator(SEL.chip)
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-board-id')))
    expect(chipIds).toEqual(ordered.map((b) => b.id))
  })

  test('B2: clicking board-new increases chip count by one', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const before = await page.locator(SEL.chip).count()
    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(before + 1, { timeout: 20000 })
  })

  test('B3: a new board is empty (zero widgets)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })

    // Select the freshly created board (the non-"Home" chip).
    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')

    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
  })

  test('B4: selecting a different board swaps the grid to its widgets', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })

    const homeChip = page.locator(`${SEL.chip}:has-text("Home")`).first()
    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()

    // Switch to the new (empty) board.
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')
    await expect(homeChip).toHaveAttribute('data-active', 'false')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })

    // Switch back to Home — its two widgets return.
    await homeChip.click()
    await expect(homeChip).toHaveAttribute('data-active', 'true')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
  })

  test('B5: active board persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })

    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()
    const newBoardId = await newChip.getAttribute('data-board-id')
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')

    await page.reload()
    await ready(page)

    const persisted = page.locator(`${SEL.chip}[data-board-id="${newBoardId}"]`)
    await expect(persisted).toHaveAttribute('data-active', 'true', { timeout: 20000 })
    // Empty board → no widgets.
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
  })

  test('B6: active-board fallback — cleared localStorage activates first board', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })

    // Activate board 2 (position 1), then wipe the persisted active-board key.
    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')

    await page.evaluate(() => localStorage.removeItem('memry-home-active-board'))
    await page.reload()
    await ready(page)

    // Fallback resolves to boards[0] (position 0) — the seeded "Home" board.
    const boards = await listBoards(page)
    const first = [...boards].sort((a, b) => a.position - b.position)[0]
    const firstChip = page.locator(`${SEL.chip}[data-board-id="${first.id}"]`)
    await expect(firstChip).toHaveAttribute('data-active', 'true', { timeout: 20000 })
  })

  test.skip('B7: FUTURE — rename / delete / reorder boards', async () => {
    // Plan 1 ships only board select + create. useHomeBoards exposes
    // renameBoard/deleteBoard/reorderBoards, but board-switcher.tsx wires
    // neither rename, delete, nor reorder controls. Enable once the switcher UI
    // exposes those actions.
  })
})

// ============================================================================
// Group C — Add widget (gallery)
// ============================================================================

test.describe('Home Dashboard — C: add widget', () => {
  test('C1: gallery lists one item per registered widget type', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await expect(page.locator(SEL.gallery)).toBeVisible()
    await expect(
      page.locator(`${SEL.galleryItem}[data-widget-type="recently-edited"]`)
    ).toHaveCount(1)
    await expect(page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`)).toHaveCount(1)
  })

  test('C2: clicking a gallery item adds a widget of that type', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`).click()
    // Seed already had one bookmarks widget → now two.
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, { timeout: 20000 })
  })

  test('C3: adding the same type twice yields two cards (instances allowed)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const item = page.locator(`${SEL.galleryItem}[data-widget-type="recently-edited"]`)
    await item.click()
    await item.click()
    // Seed had one → +2 → three recently-edited cards.
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(3, { timeout: 20000 })
  })

  test('C4: an added widget persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    await page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`).click()
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

    await removeControl(bookmarks.first()).click()
    await expect(bookmarks).toHaveCount(0, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
    await expect(page.locator(`${SEL.widget}[data-widget-id="${removedId}"]`)).toHaveCount(0)
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
  })

  test('D2: resize updates data-widget-size and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const recent = widgetsByType(page, 'recently-edited').first()
    const widgetId = await recent.getAttribute('data-widget-id')
    // Default size is M.
    await expect(recent).toHaveAttribute('data-widget-size', 'M')

    await recent.locator('[data-testid="widget-size-S"]').click()
    const sCard = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)
    await expect(sCard).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })
    // Grid span reflects size (S → span 1 col; M → span 2 cols).
    await expect(sCard).toHaveCSS('grid-column-start', 'span 1')

    await page.reload()
    await ready(page)
    const reloaded = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)
    await expect(reloaded).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })
  })

  test('D3: recently-edited/bookmarks expose only S and M (no L)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    for (const type of ['recently-edited', 'bookmarks']) {
      const card = widgetsByType(page, type).first()
      await expect(card.locator('[data-testid="widget-size-S"]')).toHaveCount(1)
      await expect(card.locator('[data-testid="widget-size-M"]')).toHaveCount(1)
      await expect(card.locator('[data-testid="widget-size-L"]')).toHaveCount(0)
    }
  })

  test('D4: reorder via drag handle changes order and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    const cards = page.locator(`${SEL.grid} ${SEL.widget}`)
    await expect(cards).toHaveCount(2)

    const order = () =>
      cards.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-widget-id')))
    const initial = await order()
    expect(initial).toHaveLength(2)

    // Drag the first card onto the second → swap order.
    await dragWidget(page, cards.nth(0), cards.nth(1))

    await expect.poll(async () => (await order())[0], { timeout: 20000 }).toBe(initial[1])
    const afterDrag = await order()
    expect(afterDrag).toEqual([initial[1], initial[0]])

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
    await expect(cards).toHaveCount(2, { timeout: 20000 })
    await expect.poll(async () => order(), { timeout: 20000 }).toEqual([initial[1], initial[0]])
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
    await page.locator(`${SEL.galleryItem}[data-widget-type="recently-edited"]`).click()
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, { timeout: 20000 })

    // Resize the bookmarks widget to S.
    const bookmark = widgetsByType(page, 'bookmarks').first()
    await bookmark.locator('[data-testid="widget-size-S"]').click()
    await expect(bookmark).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })

    // Remove the original bookmarks widget — leaving 2 recently-edited.
    await removeControl(widgetsByType(page, 'bookmarks').first()).click()
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(0, { timeout: 20000 })

    const cards = page.locator(`${SEL.grid} ${SEL.widget}`)
    await expect(cards).toHaveCount(2, { timeout: 20000 })

    // Reorder the two remaining recently-edited cards.
    const order = () =>
      cards.evaluateAll((nodes) =>
        nodes.map((n) => ({
          id: n.getAttribute('data-widget-id'),
          type: n.getAttribute('data-widget-type'),
          size: n.getAttribute('data-widget-size')
        }))
      )
    const before = await order()
    await dragWidget(page, cards.nth(0), cards.nth(1))
    await expect.poll(async () => (await order())[0].id, { timeout: 20000 }).toBe(before[1].id)
    const composed = await order()

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
    await expect(cards).toHaveCount(2, { timeout: 20000 })
    await expect.poll(async () => order(), { timeout: 20000 }).toEqual(composed)
  })

  test('E2: composed layout restored after full app restart (from data.db)', async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(120_000)
    await ready(page)
    await waitForSeed(page)

    // Compose: add a 2nd recently-edited, resize bookmarks to S.
    await page.locator(`${SEL.galleryItem}[data-widget-type="recently-edited"]`).click()
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, { timeout: 20000 })
    const bookmark = widgetsByType(page, 'bookmarks').first()
    await bookmark.locator('[data-testid="widget-size-S"]').click()
    await expect(bookmark).toHaveAttribute('data-widget-size', 'S', { timeout: 20000 })

    // Capture the persisted board state from the data DB.
    const boardsBefore = await listBoards(page)
    expect(boardsBefore).toHaveLength(1)
    const widgetsBefore = boardsBefore[0].widgets.map((w) => ({ type: w.type, size: w.size }))

    // Full restart: relaunch a brand-new Electron app against the SAME vault dir
    // (new userData → localStorage is gone; layout must come from data.db).
    const relaunched = await launchElectronWithWindow({ testVaultPath })
    try {
      const page2 = relaunched.page
      await ready(page2)
      await expect(page2.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
      await expect(page2.locator(SEL.grid)).toBeVisible({ timeout: 20000 })

      // No re-seed (still one board) and the composed widget set is intact.
      await expect(page2.locator(SEL.chip)).toHaveCount(1, { timeout: 20000 })

      const boardsAfter = await page2.evaluate(() => window.api.homePages.list())
      expect(boardsAfter).toHaveLength(1)
      const widgetsAfter = boardsAfter[0].widgets.map((w) => ({ type: w.type, size: w.size }))
      expect(widgetsAfter).toEqual(widgetsBefore)

      // And rendered: 2 recently-edited + 1 bookmarks(S).
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

    const homeChip = page.locator(`${SEL.chip}:has-text("Home")`).first()

    // Board 2: create, then give it a single bookmarks widget.
    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })
    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
    await page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`).click()
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    // Back to board 1 (Home): still the original 2 default widgets.
    await homeChip.click()
    await expect(homeChip).toHaveAttribute('data-active', 'true')
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, { timeout: 20000 })
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    // Back to board 2: still exactly its single bookmarks widget.
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')
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
    // WidgetInstanceSchema requires id/type/size/config — provide a valid size.
    await page.evaluate(
      ({ id, known }) =>
        window.api.homePages.update({
          id,
          widgets: [{ id: 'broken-1', type: 'does-not-exist', size: 'M', config: {} }, known]
        }),
      { id: board.id, known }
    )

    await page.reload()
    await ready(page)
    await expect(page.locator(SEL.homePage)).toBeVisible({ timeout: 20000 })
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })

    // Unknown widget rendered nothing; the known widget still renders.
    await expect(page.locator(`${SEL.widget}[data-widget-id="broken-1"]`)).toHaveCount(0)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1, { timeout: 20000 })
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(1, { timeout: 20000 })
  })

  test('H2: an empty board renders an empty grid with a usable gallery', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)

    // Create + activate an empty board.
    await page.locator(SEL.newBoard).click()
    await expect(page.locator(SEL.chip)).toHaveCount(2, { timeout: 20000 })
    const newChip = page.locator(`${SEL.chip}:not(:has-text("Home"))`).first()
    await newChip.click()
    await expect(newChip).toHaveAttribute('data-active', 'true')

    // Grid present but empty; gallery still usable (clicking adds a widget).
    // An empty grid div collapses to 0 height, so it is attached-but-not-"visible"
    // per Playwright's visibility heuristic — assert presence, not paint.
    await expect(page.locator(SEL.grid)).toBeAttached()
    await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(0, { timeout: 20000 })
    await expect(page.locator(SEL.gallery)).toBeVisible()
    await page.locator(`${SEL.galleryItem}[data-widget-type="bookmarks"]`).click()
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
    await expect(page.locator(SEL.grid)).toBeVisible({ timeout: 20000 })
    const homeBoards = page.locator(`${SEL.chip}:has-text("Home")`)
    await expect(homeBoards).toHaveCount(1, { timeout: 20000 })
    const boards = await listBoards(page)
    expect(boards.filter((b) => b.name === 'Home')).toHaveLength(1)
  })
})
