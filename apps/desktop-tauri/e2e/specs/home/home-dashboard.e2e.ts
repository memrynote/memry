// The Home board engine, ported from Electron's `tests/e2e/home-dashboard.e2e.ts` (Step 30c2,
// #3547): default landing, first-run seed, board switcher (select, create), the board manager
// (rename, reorder, delete), add, remove, resize and move widgets, layout persistence across a
// reload and a full app restart, per-board isolation, and edge cases. Every test runs against a
// fresh temp vault. Widget content (Recently edited, Bookmarks, Journal) is in the
// `home-widget-*` and `home-journal-widget-*` specs.
//
// Group W is Tauri-only: the board and the tab strip use CSS `color-mix()` (`home-grid.css`,
// `board-empty-state.tsx`) and `@container` queries (`tab-bar-with-drag.tsx`,
// `regular-tab.tsx`). WebKitGTK has both from 2.42, so the ubuntu-22.04 leg reads the computed
// style the app's own classes produce: a dropped declaration reads as `transparent`, an ignored
// container query leaves the tab title showing.
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { appReady } from '../../harness/app-ready'
import { dismissFirstRunOnboarding } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const SEL = {
  homePage: '[data-testid="home-page"]',
  switcher: '[data-testid="home-layout-switcher"]',
  boardItem: '[data-testid="home-layout-item"]',
  newBoard: '[data-testid="home-layout-new"]',
  grid: '.home-grid',
  gallery: '[data-testid="widget-gallery"]',
  galleryItem: '[data-testid="widget-gallery-item"]',
  addWidgetTrigger: '[data-testid="add-widget-trigger"]',
  widget: '[data-testid="widget"]',
  widgetMenu: '[data-testid="widget-menu"]',
  homeTab: '[data-testid="nav-home"]',
  manageBoards: '[data-testid="home-layout-manage"]',
  manager: '[data-testid="board-manager"]',
  managerRow: '[data-testid="board-manager-row"]',
  managerDrag: '[data-testid="board-manager-drag"]',
  managerRename: '[data-testid="board-manager-rename"]',
  managerNameInput: '[data-testid="board-manager-name-input"]',
  managerDelete: '[data-testid="board-manager-delete"]',
  emptyState: '[data-testid="board-empty-state"]'
}

const REMOVE_LABEL = 'Remove'
const ACTIVE_KEY = 'memry-home-active-board'
const T = { timeout: 20_000 }

interface Widget {
  id: string
  type: string
  x: number | null
  y: number | null
  w: number | null
  h: number | null
  config: Record<string, unknown>
}

interface Board {
  id: string
  name: string
  position: number | null
  widgets: Widget[]
}

async function ready(page: Page): Promise<void> {
  await appReady(page)
  await dismissFirstRunOnboarding(page)
}

async function reload(page: Page): Promise<void> {
  await page.reload()
  await ready(page)
}

/** The first-run seed has made the default "Home" board and its two widgets. */
async function waitForSeed(page: Page): Promise<void> {
  await expect(page.locator(SEL.homePage)).toBeVisible(T)
  await expect(page.locator(`${SEL.grid} ${SEL.widget}`)).toHaveCount(2, T)
}

/** Opens the add-widget dropdown; it closes after each pick. */
async function openWidgetGallery(page: Page): Promise<void> {
  const trigger = page.locator(SEL.addWidgetTrigger)
  await expect(trigger).toBeVisible(T)
  if (await page.locator(SEL.gallery).isVisible()) return
  await page.keyboard.press('Escape')
  await expect(page.locator(SEL.gallery))
    .toBeHidden()
    .catch(() => {})
  await trigger.click()
  await expect(page.locator(SEL.gallery)).toBeVisible(T)
}

async function addWidget(page: Page, type: string): Promise<void> {
  await openWidgetGallery(page)
  await page.locator(`${SEL.galleryItem}[data-widget-type="${type}"]`).click()
  await expect(page.locator(SEL.gallery)).toBeHidden(T)
}

const widgetsByType = (page: Page, type: string): Locator =>
  page.locator(`${SEL.grid} ${SEL.widget}[data-widget-type="${type}"]`)

const allWidgets = (page: Page): Locator => page.locator(`${SEL.grid} ${SEL.widget}`)

async function removeWidget(page: Page, card: Locator): Promise<void> {
  await card.locator(SEL.widgetMenu).click()
  await page.getByRole('menuitem', { name: REMOVE_LABEL }).click()
}

/** The boards as `data.db` holds them, read through the renderer's command. */
const listBoards = (page: Page): Promise<Board[]> => invoke<Board[]>(page, 'home_pages_list')

const byPosition = (boards: Board[]): Board[] =>
  boards.toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))

/** Rewrites one widget of whichever board holds it. The RGL grip has no test hook. */
async function patchWidget(page: Page, widgetId: string, patch: Partial<Widget>): Promise<void> {
  const board = (await listBoards(page)).find((b) => b.widgets.some((w) => w.id === widgetId))
  if (!board) throw new Error(`no board with widget ${widgetId}`)
  const widgets = board.widgets.map((w) => (w.id === widgetId ? { ...w, ...patch } : w))
  await invoke(page, 'home_pages_update', { input: { id: board.id, widgets } })
}

async function widgetCoords(page: Page, boardId: string): Promise<Record<string, { x: unknown }>> {
  const board = (await listBoards(page)).find((b) => b.id === boardId)
  return Object.fromEntries((board?.widgets ?? []).map((w) => [w.id, { x: w.x }]))
}

const boardItems = (page: Page): Locator => page.locator(SEL.boardItem)

/** Opens the switcher from a closed state; Radix animates the menu in and out. */
async function openSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(boardItems(page))
    .toHaveCount(0)
    .catch(() => {})
  await page.locator(SEL.switcher).click()
  await expect(boardItems(page).first()).toBeVisible(T)
}

async function createBoard(page: Page): Promise<void> {
  await openSwitcher(page)
  await page.locator(SEL.newBoard).click()
  await expect(boardItems(page).first()).toBeHidden(T)
}

async function selectBoard(page: Page, boardId: string): Promise<void> {
  await openSwitcher(page)
  const item = page.locator(`${SEL.boardItem}[data-board-id="${boardId}"]`)
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(boardItems(page).first()).toBeHidden(T)
}

async function openBoardManager(page: Page): Promise<void> {
  await openSwitcher(page)
  await page.locator(SEL.manageBoards).click()
  await expect(page.locator(SEL.manager)).toBeVisible(T)
  await expect(page.locator(SEL.managerRow).first()).toBeVisible(T)
}

async function closeBoardManager(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator(SEL.manager)).toBeHidden(T)
}

const boardIdsInOrder = async (page: Page): Promise<string[]> =>
  byPosition(await listBoards(page)).map((b) => b.id)

const managerHandle = (page: Page, boardId: string): Locator =>
  page.locator(`${SEL.managerRow}[data-board-id="${boardId}"] ${SEL.managerDrag}`).first()

/** Two boards with the manager open; returns their ids in the saved order. */
async function openManagerWithTwoBoards(page: Page): Promise<string[]> {
  await ready(page)
  await waitForSeed(page)
  await createBoard(page)
  await expect.poll(async () => (await listBoards(page)).length, T).toBe(2)
  const before = await boardIdsInOrder(page)
  await openBoardManager(page)
  return before
}

/** dnd-kit moves the row the dragged one passes once it has measured the drag over that row. */
const waitForRowShift = (page: Page, boardId: string): Promise<void> =>
  expect
    .poll(
      () =>
        page
          .locator(`${SEL.managerRow}[data-board-id="${boardId}"]`)
          .evaluate((row: HTMLElement) => row.style.transform),
      T
    )
    .toMatch(/translate3d\(\S+, [1-9]/)

/** The two boards trade places, in `data.db` and still after a reload. */
async function expectBoardsSwapped(page: Page, before: string[]): Promise<void> {
  const swapped = [before[1], before[0]].join(',')
  await expect.poll(async () => (await boardIdsInOrder(page)).join(','), T).toBe(swapped)

  await closeBoardManager(page)
  await reload(page)
  expect((await boardIdsInOrder(page)).join(',')).toBe(swapped)
}

/**
 * One pointer event on a handle, as a mouse makes it. WKWebView's WebDriver sends no `pointermove`
 * (HOOKS.md, Porting a spec), so a drag is dispatched in the page, as
 * `specs/editor/table-cell-image.e2e.ts` does for its grip.
 */
const pointerAt = (
  handle: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number
): Promise<void> =>
  handle.evaluate(
    (el: HTMLElement, p: { type: string; x: number; y: number }) => {
      el.dispatchEvent(
        new PointerEvent(p.type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: p.type === 'pointerup' ? 0 : 1,
          clientX: p.x,
          clientY: p.y
        })
      )
    },
    { type, x, y }
  )

const activeBoardId = (page: Page): Promise<string | null> =>
  page.evaluate((key: string) => localStorage.getItem(key), ACTIVE_KEY)

/** Creates a second board, switches to it, and returns it. */
async function createAndSelectBoard(page: Page): Promise<Board> {
  await createBoard(page)
  await expect.poll(async () => (await listBoards(page)).length, T).toBe(2)
  const board = (await listBoards(page)).find((b) => b.name !== 'Home')!
  await selectBoard(page, board.id)
  await expect(page.locator(SEL.switcher)).toContainText(board.name, T)
  return board
}

test.describe('Home Dashboard — A: landing & seed', () => {
  test('A1: fresh vault lands on Home without manual navigation', async ({ page }) => {
    await ready(page)
    await expect(page.locator(SEL.homePage)).toBeVisible(T)
  })

  test('A2: default board named "Home" auto-seeded exactly once', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await expect(page.locator(SEL.switcher)).toContainText('Home', T)
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(1, T)
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
    await reload(page)
    await expect(page.locator(SEL.switcher)).toContainText('Home', T)
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(1, T)
    await page.keyboard.press('Escape')
    await expect(allWidgets(page)).toHaveCount(2, T)
  })

  test('A5: Home is a singleton tab — re-opening focuses the existing tab', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await expect(page.locator(SEL.homeTab)).toHaveCount(1)
    await page.locator(SEL.homeTab).first().click()
    await expect(page.locator(SEL.homeTab)).toHaveCount(1)
    await expect(page.locator(SEL.homePage)).toBeVisible()
  })
})

test.describe('Home Dashboard — B: board switcher & multi-board', () => {
  test('B1: one menu item per board, ordered by position', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, T).toBe(2)

    const ordered = byPosition(await listBoards(page))
    await openSwitcher(page)
    await expect(boardItems(page)).toHaveCount(2, T)
    const itemIds = await page.evaluate(
      (sel: string) =>
        Array.from(document.querySelectorAll(sel)).map((n) => n.getAttribute('data-board-id')),
      SEL.boardItem
    )
    expect(itemIds).toEqual(ordered.map((b) => b.id))
  })

  test('B2: creating a board increases the board count by one', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const before = (await listBoards(page)).length
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, T).toBe(before + 1)
  })

  test('B3: a new board is empty (zero widgets)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await createAndSelectBoard(page)
    await expect(allWidgets(page)).toHaveCount(0, T)
  })

  test('B4: selecting a different board swaps the grid to its widgets', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const home = (await listBoards(page)).find((b) => b.name === 'Home')!
    await createAndSelectBoard(page)
    await expect(allWidgets(page)).toHaveCount(0, T)

    await selectBoard(page, home.id)
    await expect(page.locator(SEL.switcher)).toContainText('Home', T)
    await expect(allWidgets(page)).toHaveCount(2, T)
  })

  test('B5: active board persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const board = await createAndSelectBoard(page)

    await reload(page)
    await expect(page.locator(SEL.switcher)).toContainText(board.name, T)
    expect(await activeBoardId(page)).toBe(board.id)
    await expect(allWidgets(page)).toHaveCount(0, T)
  })

  test('B6: active-board fallback — cleared localStorage activates first board', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)
    await createAndSelectBoard(page)

    await page.evaluate((key: string) => localStorage.removeItem(key), ACTIVE_KEY)
    await reload(page)

    const first = byPosition(await listBoards(page))[0]
    await expect(page.locator(SEL.switcher)).toContainText(first.name, T)
  })

  test('B7: renaming a board from the manager persists and re-labels the switcher', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)
    const [board] = await listBoards(page)
    await openBoardManager(page)

    await page
      .locator(`${SEL.managerRow}[data-board-id="${board.id}"] ${SEL.managerRename}`)
      .click()

    // A Radix menu gives focus back to its trigger ~150 ms after it unmounts, which would blur
    // the field and commit the unchanged name: the field must keep focus past that.
    const input = page.locator(SEL.managerNameInput)
    await expect(input).toBeFocused(T)
    await page.waitForTimeout(600)
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    await input.fill('Planning')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await listBoards(page)).find((b) => b.id === board.id)?.name, T)
      .toBe('Planning')

    await closeBoardManager(page)
    await expect(page.locator(SEL.switcher)).toContainText('Planning', T)
    await reload(page)
    await expect(page.locator(SEL.switcher)).toContainText('Planning', T)
  })

  test('B8: moving a row in the manager reorders the boards', async ({ page }) => {
    const before = await openManagerWithTwoBoards(page)

    // dnd-kit's keyboard sensor (Enter, ArrowUp, Enter) on the row's handle runs the same
    // `onReorder` as a pointer drag (B8b). Its Space key arrives with an empty `code` on
    // WKWebView's WebDriver, which dnd-kit does not read as Space.
    const handle = managerHandle(page, before[1])
    await handle.focus()
    await page.keyboard.press('Enter')
    await expect(handle).toHaveAttribute('aria-pressed', 'true', T)
    await page.keyboard.press('ArrowUp')
    await waitForRowShift(page, before[0])
    await page.keyboard.press('Enter')

    await expectBoardsSwapped(page, before)
  })

  test('B8b: dragging a row handle with the pointer reorders the boards', async ({ page }) => {
    const before = await openManagerWithTwoBoards(page)

    // `PointerSensor` starts the drag after 6 px of movement, then dnd-kit measures the rows and
    // finds the one the pointer is over after the next move: each step waits for the state the
    // previous one sets, as a hand's pace would.
    const handle = managerHandle(page, before[1])
    const from = await handle.boundingBox()
    const target = await managerHandle(page, before[0]).boundingBox()
    if (!from || !target) throw new Error('the manager rows have no box')
    const x = from.x + from.width / 2
    const y = from.y + from.height / 2
    const over = y + (target.y - from.y)

    await pointerAt(handle, 'pointerdown', x, y)
    await pointerAt(handle, 'pointermove', x, y - 8)
    await expect(handle).toHaveAttribute('aria-pressed', 'true', T)
    await pointerAt(handle, 'pointermove', x, over)
    await waitForRowShift(page, before[0])
    await pointerAt(handle, 'pointerup', x, over)

    await expectBoardsSwapped(page, before)
  })

  test('B9: deleting a board from the manager removes it', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await createBoard(page)
    await expect.poll(async () => (await listBoards(page)).length, T).toBe(2)

    const doomed = (await listBoards(page)).find((b) => b.name !== 'Home')!
    await openBoardManager(page)
    await page
      .locator(`${SEL.managerRow}[data-board-id="${doomed.id}"] ${SEL.managerDelete}`)
      .click()

    await expect
      .poll(async () => (await listBoards(page)).map((b) => b.id), T)
      .not.toContain(doomed.id)
    // The last board cannot be deleted.
    await expect(page.locator(SEL.managerRow)).toHaveCount(1, T)
    await expect(page.locator(SEL.managerDelete)).toBeDisabled(T)
  })
})

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
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, T)
  })

  test('C3: adding the same type twice yields two cards (instances allowed)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await addWidget(page, 'recently-edited')
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, T)
    await addWidget(page, 'recently-edited')
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(3, T)
  })

  test('C4: an added widget persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await addWidget(page, 'bookmarks')
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, T)
    await reload(page)
    await expect(page.locator(SEL.grid)).toBeVisible(T)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(2, T)
  })
})

test.describe('Home Dashboard — D: widget frame controls', () => {
  test('D1: remove deletes the card and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const bookmarks = widgetsByType(page, 'bookmarks')
    await expect(bookmarks).toHaveCount(1)
    const removedId = await bookmarks.first().getAttribute('data-widget-id')

    await removeWidget(page, bookmarks.first())
    await expect(bookmarks).toHaveCount(0, T)
    await expect(allWidgets(page)).toHaveCount(1, T)

    await reload(page)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${removedId}"]`)).toHaveCount(0)
    await expect(allWidgets(page)).toHaveCount(1, T)
  })

  test('D2: resize updates the derived size tier and persists across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const recent = widgetsByType(page, 'recently-edited').first()
    const widgetId = (await recent.getAttribute('data-widget-id'))!
    await expect(recent).toHaveAttribute('data-widget-size', 'M')

    await patchWidget(page, widgetId, { h: 2 })
    await reload(page)
    const card = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)
    await expect(card).toHaveAttribute('data-widget-size', 'S', T)
  })

  test('D3: size tier is derived from the grid span (S/M/L by height)', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const widgetId = (await widgetsByType(page, 'recently-edited')
      .first()
      .getAttribute('data-widget-id'))!
    const card = page.locator(`${SEL.widget}[data-widget-id="${widgetId}"]`)

    // sizeTier: h <= 2 is S, h <= 4 is M, else L.
    for (const [h, tier] of [
      [2, 'S'],
      [4, 'M'],
      [6, 'L']
    ] as const) {
      await patchWidget(page, widgetId, { h })
      await reload(page)
      await expect(card).toHaveAttribute('data-widget-size', tier, T)
    }
  })

  test('D4: a moved widget keeps its grid position across reload', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const cards = allWidgets(page)
    await expect(cards).toHaveCount(2)
    const boardId = (await listBoards(page))[0].id
    const movedId = (await cards.first().getAttribute('data-widget-id'))!

    // RGL compacts y vertically, so only the column is stable.
    await patchWidget(page, movedId, { x: 4, y: 8 })
    await reload(page)
    await expect(cards).toHaveCount(2, T)
    await expect.poll(async () => (await widgetCoords(page, boardId))[movedId]?.x, T).toBe(4)
  })
})

/** Adds a second recently-edited widget and shrinks bookmarks to the S tier; answers its id. */
async function composeLayout(page: Page): Promise<string> {
  await addWidget(page, 'recently-edited')
  await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, T)
  const bookmarkId = (await widgetsByType(page, 'bookmarks')
    .first()
    .getAttribute('data-widget-id'))!
  await patchWidget(page, bookmarkId, { h: 2 })
  await reload(page)
  await expect(page.locator(`${SEL.widget}[data-widget-id="${bookmarkId}"]`)).toHaveAttribute(
    'data-widget-size',
    'S',
    T
  )
  return bookmarkId
}

test.describe('Home Dashboard — E: layout persistence', () => {
  test('E1: composed layout (add/resize/reorder/remove) restored after reload', async ({
    page
  }) => {
    await ready(page)
    await waitForSeed(page)
    const bookmarkId = await composeLayout(page)

    const recentId = (await widgetsByType(page, 'recently-edited')
      .first()
      .getAttribute('data-widget-id'))!
    await patchWidget(page, recentId, { x: 4, y: 10 })
    const boardId = (await listBoards(page))[0].id

    await reload(page)
    await expect(allWidgets(page)).toHaveCount(3, T)
    await expect(page.locator(`${SEL.widget}[data-widget-id="${bookmarkId}"]`)).toHaveAttribute(
      'data-widget-size',
      'S',
      T
    )
    await expect.poll(async () => (await widgetCoords(page, boardId))[recentId]?.x, T).toBe(4)
  })

  test('E2: composed layout restored after full app restart (from data.db)', async ({
    app,
    page
  }) => {
    await ready(page)
    await waitForSeed(page)
    await composeLayout(page)

    const boardsBefore = await listBoards(page)
    expect(boardsBefore).toHaveLength(1)
    const shape = (b: Board) => b.widgets.map((w) => ({ type: w.type, w: w.w, h: w.h }))
    const widgetsBefore = shape(boardsBefore[0])

    // Electron relaunched with a new userData dir. `restart` keeps the webview profile, so
    // clear localStorage first: the layout must come from data.db.
    await page.evaluate(() => localStorage.clear())
    await restart(app)
    await ready(page)
    await expect(page.locator(SEL.homePage)).toBeVisible(T)
    await expect(allWidgets(page)).toHaveCount(3, T)

    const boardsAfter = await listBoards(page)
    expect(boardsAfter).toHaveLength(1)
    expect(shape(boardsAfter[0])).toEqual(widgetsBefore)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(2, T)
    const bookmarks = widgetsByType(page, 'bookmarks')
    await expect(bookmarks).toHaveCount(1)
    await expect(bookmarks.first()).toHaveAttribute('data-widget-size', 'S')
  })

  test('E3: per-board isolation — each board keeps its own layout', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const home = (await listBoards(page)).find((b) => b.name === 'Home')!

    const board = await createAndSelectBoard(page)
    await expect(allWidgets(page)).toHaveCount(0, T)
    await addWidget(page, 'bookmarks')
    await expect(allWidgets(page)).toHaveCount(1, T)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    await selectBoard(page, home.id)
    await expect(page.locator(SEL.switcher)).toContainText('Home', T)
    await expect(allWidgets(page)).toHaveCount(2, T)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)

    await selectBoard(page, board.id)
    await expect(page.locator(SEL.switcher)).toContainText(board.name, T)
    await expect(allWidgets(page)).toHaveCount(1, T)
    await expect(widgetsByType(page, 'bookmarks')).toHaveCount(1)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(0)
  })
})

test.describe('Home Dashboard — H: edge cases', () => {
  test('H1: unknown widget type is skipped without crashing the board', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const board = (await listBoards(page))[0]
    const known = board.widgets.find((w) => w.type === 'recently-edited')
    expect(known).toBeTruthy()

    await invoke(page, 'home_pages_update', {
      input: {
        id: board.id,
        widgets: [
          { id: 'broken-1', type: 'does-not-exist', x: 0, y: 0, w: 4, h: 4, config: {} },
          known
        ]
      }
    })
    await reload(page)
    await expect(page.locator(SEL.homePage)).toBeVisible(T)

    const broken = page.locator(`${SEL.widget}[data-widget-id="broken-1"]`)
    await expect(broken).toHaveCount(1, T)
    await expect(broken.locator('[data-testid="widget-unknown"]')).toHaveCount(1)
    await expect(widgetsByType(page, 'recently-edited')).toHaveCount(1, T)
    await expect(allWidgets(page)).toHaveCount(2, T)
  })

  test('H2: an empty board renders an empty grid with a usable gallery', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await createAndSelectBoard(page)
    // An empty grid has no height: assert it is in the DOM, not painted.
    await expect(page.locator(SEL.grid)).toHaveCount(1)
    await expect(allWidgets(page)).toHaveCount(0, T)
    await addWidget(page, 'bookmarks')
    await expect(allWidgets(page)).toHaveCount(1, T)
  })

  test('H3: rapid reloads after seed never create more than one Home board', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    for (let i = 0; i < 3; i += 1) {
      await reload(page)
      await expect(page.locator(SEL.homePage)).toBeVisible(T)
    }
    await expect(allWidgets(page).first()).toBeVisible(T)
    const boards = await listBoards(page)
    expect(boards.filter((b) => b.name === 'Home')).toHaveLength(1)
  })
})

/** `[major, minor]` of a `x.y.z` version string. */
const majorMinor = (version: string): [number, number] => {
  const [major, minor] = version.split('.').map(Number)
  return [major, minor]
}

test.describe('Home Dashboard — W: engine CSS (Tauri)', () => {
  test('W1: the linked WebKitGTK is 2.42 or newer on Linux', async ({ app }) => {
    const version = await invokeTest<string | null>(app, 'e2e_webkitgtk_version')
    console.log(`home-dashboard on ${process.platform}, WebKitGTK ${version ?? '-'}`)
    if (process.platform !== 'linux') {
      expect(version).toBeNull()
      return
    }
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const [major, minor] = majorMinor(version!)
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(2 * 1000 + 42)
  })

  test('W2: color-mix() paints the empty-board badge at 12% of the tint', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    await createAndSelectBoard(page)
    const badge = page.locator(`${SEL.emptyState} > [aria-hidden="true"]`)
    await expect(badge).toBeVisible(T)

    // `bg-[color-mix(in_srgb,var(--tint)_12%,transparent)]`: Tailwind ships the mix inside
    // `@supports (color: color-mix(...))` over an opaque `var(--tint)` fallback, so an engine
    // without color-mix() paints the badge at alpha 1.
    const background = await page.evaluate(
      (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor,
      `${SEL.emptyState} > [aria-hidden="true"]`
    )
    console.log(`empty-board badge background: ${background}`)
    // `rgba(r, g, b, a)` or `color(srgb r g b / a)`; `rgb(...)` and no `/` have alpha 1.
    const match = /^rgba\(.*,\s*([\d.]+)\)$/.exec(background) ?? /\/\s*([\d.]+)\)$/.exec(background)
    const alpha = match ? Number(match[1]) : 1
    expect(alpha).toBeGreaterThan(0.1)
    expect(alpha).toBeLessThan(0.14)
  })

  test('W3: an @container query hides the Home tab title below 76px', async ({ page }) => {
    await ready(page)
    await waitForSeed(page)
    const tab = page.locator(SEL.homeTab)
    await expect(tab).toHaveCount(1)

    // The tab's wrapper is the `@container`; the title carries `@max-[76px]:hidden`.
    const read = () =>
      page.evaluate((sel: string) => {
        const tabEl = document.querySelector(sel)!
        const title = tabEl.querySelector('span.truncate')!
        return {
          containerType: getComputedStyle(tabEl.closest('[class~="@container"]')!).containerType,
          titleDisplay: getComputedStyle(title).display
        }
      }, SEL.homeTab)
    const squeeze = (width: string | null) =>
      page.evaluate(
        ([sel, w]: [string, string | null]) => {
          const wrapper = document
            .querySelector(sel)!
            .closest<HTMLElement>('[class~="@container"]')!
          if (w === null) {
            wrapper.style.removeProperty('width')
            wrapper.style.removeProperty('flex')
          } else {
            wrapper.style.setProperty('flex', 'none', 'important')
            wrapper.style.setProperty('width', w, 'important')
          }
        },
        [SEL.homeTab, width]
      )

    const wide = await read()
    expect(wide.containerType).toBe('inline-size')
    expect(wide.titleDisplay).not.toBe('none')

    await squeeze('60px')
    await expect.poll(async () => (await read()).titleDisplay, T).toBe('none')
    await squeeze(null)
    await expect.poll(async () => (await read()).titleDisplay, T).not.toBe('none')
  })
})
