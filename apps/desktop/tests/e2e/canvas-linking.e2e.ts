// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M3 — linking (bound arrows between item cards).
 *
 * Interaction path taken: the NATIVE Excalidraw arrow tool. Our card is a plain
 * (unlocked) bindable rectangle and the DOM overlay is pointer-events:none, so
 * an arrow-tool drag reaches Excalidraw's canvas and binds to the rectangles on
 * hover — no custom connect gesture is needed. `convertToExcalidrawElements`'s
 * `start.id`/`end.id` only resolve batch-local (the function never receives the
 * scene), so binding two PRE-EXISTING cards is Excalidraw's job, not ours.
 *
 * Bound arrows live in the scene blob (no new tables). Persistence + bindings
 * are asserted through the scene JSON from window.api.canvas.get, per §18 B4.
 * The tool is selected with the stable numeric shortcut '5' (mirrors M1's
 * freedraw-via-'7'); cards are aimed by their overlay DOM boundingBox.
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

/**
 * A cold first launch opens the vault slowly (embedding-model init can take
 * ~30s), exceeding waitForVaultReady's internal 15s fallback — wait for the
 * sidebar to appear before ready() runs its onboarding dismissal.
 */
async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

async function setSpatialCanvasFlag(page: Page, enabled: boolean): Promise<void> {
  const result = await page.evaluate(
    async (value) => window.api.settings.setFeaturesSettings({ spatialCanvas: value }),
    enabled
  )
  if (!result?.success) throw new Error(result?.error ?? 'setFeaturesSettings failed')
  await page.reload()
  await openVault(page)
}

async function createCanvasFromSidebar(page: Page): Promise<string> {
  const header = page.getByRole('button', { name: /Canvases section/ })
  await expect(header).toBeVisible()
  await header.hover()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20000 })
  const list = await page.evaluate(async () => window.api.canvas.list())
  return list.canvases[0].id
}

async function seedNote(page: Page, title: string, content: string): Promise<string> {
  const res = await page.evaluate(
    async ({ t, c }) => window.api.notes.create({ title: t, content: c }),
    { t: title, c: content }
  )
  if (!res?.note?.id) throw new Error(`seedNote failed for ${title}`)
  return res.note.id
}

/** Dispatch a canvas-item drop at a client point offset from the canvas center. */
async function dropNote(page: Page, noteId: string, dx = 0, dy = 0): Promise<void> {
  await page.evaluate(
    ({ id, ddx, ddy }) => {
      const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
      const r = wrapper.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData(
        'application/x-memry-canvas-item',
        JSON.stringify({ entityType: 'note', entityId: id })
      )
      const ev = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2 + ddx,
        clientY: r.top + r.height / 2 + ddy
      })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      wrapper.dispatchEvent(ev)
    },
    { id: noteId, ddx: dx, ddy: dy }
  )
}

async function sceneOf(page: Page, canvasId: string) {
  return page.evaluate(async (id) => {
    const c = await window.api.canvas.get(id)
    return { scene: c?.scene ?? '', parsed: c?.scene ? JSON.parse(c.scene) : { elements: [] } }
  }, canvasId)
}

function cardRects(parsed) {
  return (parsed.elements ?? []).filter(
    (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId
  )
}

/** The first live, fully-bound arrow in a scene (null until both ends bind). */
function boundArrow(parsed) {
  return (parsed.elements ?? []).find(
    (e) => e.type === 'arrow' && !e.isDeleted && e.startBinding && e.endBinding
  )
}

/** Geometry signature that changes when a bound arrow re-routes. */
function arrowGeometry(arrow) {
  return JSON.stringify({
    x: arrow.x,
    y: arrow.y,
    width: arrow.width,
    height: arrow.height,
    points: arrow.points
  })
}

/** Center of a card's overlay DOM box, in viewport (client) coordinates. */
async function cardCenter(page: Page, noteId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-canvas-card-entity="note:${noteId}"]`).boundingBox()
  if (!box) throw new Error(`no bounding box for note:${noteId}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('Spatial canvas — linking (M3)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('connect two cards with a bound arrow; moving a card re-routes it; reload persists', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    // Two distinct note cards, spread apart so the arrow spans a clear gap.
    const a = await seedNote(page, `LinkA ${Date.now()}`, 'body a')
    const b = await seedNote(page, `LinkB ${Date.now()}`, 'body b')
    await dropNote(page, a, -250, 0)
    await dropNote(page, b, 250, 0)

    const cardA = page.locator(`[data-canvas-card-entity="note:${a}"]`)
    const cardB = page.locator(`[data-canvas-card-entity="note:${b}"]`)
    await expect(cardA).toBeVisible({ timeout: 20000 })
    await expect(cardB).toBeVisible({ timeout: 20000 })
    await expect
      .poll(async () => cardRects((await sceneOf(page, canvasId)).parsed).length, {
        timeout: 15000
      })
      .toBe(2)

    const rectIdA = await cardA.getAttribute('data-canvas-card-id')
    const rectIdB = await cardB.getAttribute('data-canvas-card-id')

    // Draw a native arrow from card A to card B. Focus the canvas on an empty
    // spot (bottom-left, clear of the top toolbar island and bottom New-note
    // button), select the arrow tool via the stable numeric shortcut, then drag
    // center-to-center; Excalidraw binds to the rectangle it started/ended over.
    const editor = await page.locator('[data-canvas-editor]').boundingBox()
    await page.mouse.click(editor.x + 30, editor.y + editor.height - 80)
    await page.keyboard.press('5')
    const centerA = await cardCenter(page, a)
    const centerB = await cardCenter(page, b)
    await page.mouse.move(centerA.x, centerA.y)
    await page.mouse.down()
    await page.mouse.move((centerA.x + centerB.x) / 2, (centerA.y + centerB.y) / 2, { steps: 8 })
    await page.mouse.move(centerB.x, centerB.y, { steps: 8 })
    await page.mouse.up()

    // A bound arrow lands in the persisted scene, referencing both rectangles.
    await expect
      .poll(async () => !!boundArrow((await sceneOf(page, canvasId)).parsed), { timeout: 15000 })
      .toBe(true)

    let arrow = boundArrow((await sceneOf(page, canvasId)).parsed)
    const boundIds = [arrow.startBinding.elementId, arrow.endBinding.elementId].sort()
    expect(boundIds).toEqual([rectIdA, rectIdB].sort())

    // Binding is two-way: each rectangle lists the arrow in boundElements.
    const rectsById = Object.fromEntries(
      cardRects((await sceneOf(page, canvasId)).parsed).map((r) => [r.id, r])
    )
    expect((rectsById[rectIdA].boundElements ?? []).some((be) => be.id === arrow.id)).toBe(true)
    expect((rectsById[rectIdB].boundElements ?? []).some((be) => be.id === arrow.id)).toBe(true)

    const geometryBefore = arrowGeometry(arrow)

    // Move card B and assert the bound arrow re-routes (its end is bound to B).
    // Both cards share a Y, so the arrow runs horizontally across their
    // mid-height; the freshly drawn arrow also stays selected. Grabbing at
    // mid-height therefore lands on the arrow, not the card. Grab card B in its
    // LOWER half instead — below the arrow line and clear of the top-end ↗
    // button — so mousedown hits the filled rectangle (selecting it, which
    // deselects the arrow) and the drag moves the card, re-routing the arrow.
    const boxB = await page.locator(`[data-canvas-card-entity="note:${b}"]`).boundingBox()
    const bx = boxB.x + boxB.width * 0.5
    const by = boxB.y + boxB.height * 0.8
    await page.mouse.move(bx, by)
    await page.mouse.down()
    await page.mouse.move(bx - 40, by + 120, { steps: 10 })
    await page.mouse.move(bx - 90, by + 230, { steps: 10 })
    await page.mouse.up()

    await expect
      .poll(
        async () => {
          const moved = boundArrow((await sceneOf(page, canvasId)).parsed)
          if (!moved) return 'no-bound-arrow'
          return arrowGeometry(moved) === geometryBefore ? 'unchanged' : 'rerouted'
        },
        { timeout: 15000 }
      )
      .toBe('rerouted')

    // Bindings survive the move: same arrow, same two rectangle ids.
    arrow = boundArrow((await sceneOf(page, canvasId)).parsed)
    expect([arrow.startBinding.elementId, arrow.endBinding.elementId].sort()).toEqual(
      [rectIdA, rectIdB].sort()
    )

    // Reload: the link persists in the restored scene.
    await page.reload()
    await openVault(page)
    const persisted = boundArrow((await sceneOf(page, canvasId)).parsed)
    expect(persisted).toBeTruthy()
    expect([persisted.startBinding.elementId, persisted.endBinding.elementId].sort()).toEqual(
      [rectIdA, rectIdB].sort()
    )
  })
})
