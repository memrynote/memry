// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M2 — item cards (rectangle + read-only overlay preview).
 *
 * Cards reference real entities by id (no content copied). The drop is driven
 * by a synthetic DragEvent carrying the canvas MIME (Playwright's native DnD
 * doesn't populate a capture-phase dataTransfer reliably); everything else
 * uses window.api. Persistence + no-copy are asserted via the scene JSON from
 * window.api.canvas.get, per the design spec (§18 B4).
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

/**
 * A cold first launch opens the vault slowly (embedding-model init can take
 * ~30s), which exceeds waitForVaultReady's internal 15s fallback — so wait for
 * the sidebar to actually appear before ready() runs its onboarding dismissal.
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

async function seedTask(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (t) => {
    const projects = await window.api.tasks.listProjects()
    const projectId = projects?.projects?.[0]?.id
    if (!projectId) return ''
    const res = await window.api.tasks.create({ projectId, title: t })
    return res?.task?.id ?? res?.id ?? ''
  }, title)
  if (!id) throw new Error(`seedTask failed for ${title}`)
  return id
}

/** Dispatch a canvas-item drop at a client point (defaults to canvas center). */
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

function cardRects(parsed): Array<{ customData?: { entityId?: string } }> {
  return (parsed.elements ?? []).filter(
    (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId
  )
}

test.describe('Spatial canvas — item cards (M2)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('drop a note → referencing card (no content copied) + ↗ opens the note tab', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    const marker = `BODYMARKER_${Date.now()}`
    const title = `Alpha ${Date.now()}`
    const noteId = await seedNote(page, title, `secret ${marker} body`)

    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).toContainText(title, { timeout: 20000 })

    // Referencing, not copying: the scene holds a rectangle with the note id in
    // customData but never the note body.
    await expect
      .poll(async () => cardRects((await sceneOf(page, canvasId)).parsed).length, {
        timeout: 15000
      })
      .toBeGreaterThan(0)
    const { scene, parsed } = await sceneOf(page, canvasId)
    expect(cardRects(parsed).some((r) => r.customData?.entityId === noteId)).toBe(true)
    expect(scene).not.toContain(marker)

    // ↗ redirect opens the note in its own tab.
    await card.getByRole('button', { name: 'Open in tab' }).click()
    await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })
  })

  test('card reflects a title edit made elsewhere, then goes dangling on delete', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)

    const title = `Beta ${Date.now()}`
    const noteId = await seedNote(page, title, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toContainText(title, { timeout: 20000 })

    const renamed = `Renamed ${Date.now()}`
    await page.evaluate(async ({ id, t }) => window.api.notes.rename(id, t), {
      id: noteId,
      t: renamed
    })
    await expect(card).toContainText(renamed, { timeout: 20000 })

    await page.evaluate(async (id) => window.api.notes.delete(id), noteId)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'dangling', { timeout: 20000 })
  })

  test('capture-first: the Add card picker creates a note card on the canvas', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    await page.getByTestId('canvas-add-card').click()
    await page.getByTestId('canvas-add-create-note').click()

    await expect(page.locator('[data-canvas-card-id]')).toHaveCount(1, { timeout: 20000 })
    await expect
      .poll(async () => cardRects((await sceneOf(page, canvasId)).parsed).length, {
        timeout: 15000
      })
      .toBe(1)
  })

  test('the Add card picker places an existing task card on the canvas', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    const title = `Canvas Task ${Date.now()}`
    await seedTask(page, title)

    await page.getByTestId('canvas-add-card').click()
    // The picker debounces search 150ms after the query changes (see
    // use-canvas-add-search.ts). Fill once and poll for the row: re-filling
    // on every poll tick (as an earlier version of this test did) clears the
    // query to '' first, which synchronously resets results to empty and
    // races the very debounce it's trying to observe, so the row can never
    // appear before the next reset — a self-cancelling loop, not evidence of
    // a slow index (verified empirically: search.quick sees the task
    // immediately after creation).
    await page.getByTestId('canvas-add-input').fill(title)
    await expect
      .poll(async () => page.locator('[data-testid^="canvas-add-item-task:"]').count(), {
        timeout: 10000
      })
      .toBeGreaterThan(0)

    await page.locator('[data-testid^="canvas-add-item-task:"]').first().click()

    await expect(page.locator('[data-canvas-card-id]')).toHaveCount(1, { timeout: 20000 })
    await expect
      .poll(
        async () => {
          const rects = cardRects((await sceneOf(page, canvasId)).parsed)
          return rects.filter((r) => r.customData?.entityType === 'task').length
        },
        { timeout: 15000 }
      )
      .toBe(1)
  })

  test('overlay stays synced on pan and virtualizes off-screen cards', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    const noteId = await seedNote(page, `Grid ${Date.now()}`, 'body')
    // Spread cards far apart so most fall outside the padded viewport.
    for (let i = 0; i < 8; i++) {
      await dropNote(page, noteId, (i - 4) * 900, 0)
    }
    await expect
      .poll(async () => cardRects((await sceneOf(page, canvasId)).parsed).length, {
        timeout: 15000
      })
      .toBe(8)

    // Virtualization: fewer cards are mounted than exist in the scene.
    const mounted = await page.locator('[data-canvas-card-id]').count()
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(8)

    // Pan updates the overlay's scroll stamp (imperative transform sync).
    const before = await page
      .locator('[data-canvas-overlay]')
      .evaluate((el) => el.parentElement?.getAttribute('data-scroll-x'))
    const box = await page.locator('[data-canvas-editor]').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(600, 0)
    await expect
      .poll(
        async () =>
          page
            .locator('[data-canvas-overlay]')
            .evaluate((el) => el.parentElement?.getAttribute('data-scroll-x')),
        { timeout: 10000 }
      )
      .not.toBe(before)
  })
})
