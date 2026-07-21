// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M6 — in-place live editing. Double-click promotes ONE card to
 * active; click-away/Escape returns to idle. ↗ redirect stays distinct from
 * editing (matrix #20). Later tasks add note/task/event body assertions.
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

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
  await page.getByRole('button', { name: 'New canvas' }).click()
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
/** Double-click the visual center of a card's overlay div. */
async function dblclickCard(page: Page, entity: string): Promise<void> {
  const box = await page.locator(`[data-canvas-card-entity="${entity}"]`).boundingBox()
  if (!box) throw new Error(`no card box for ${entity}`)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('Spatial canvas — in-place editing (M6)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('double-click activates one card; Escape and click-away return to idle', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const noteId = await seedNote(page, `Active ${Date.now()}`, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).toHaveAttribute('data-canvas-card-state', 'ready', { timeout: 20000 })

    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    await page.keyboard.press('Escape')
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    // Re-activate, then click-away on empty canvas returns to idle.
    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    const wrap = await page.locator('[data-canvas-editor]').boundingBox()
    await page.mouse.click(wrap.x + 20, wrap.y + 20)
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
  })

  test('↗ redirect and double-click do not cross-fire (matrix #20)', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const title = `Redirect ${Date.now()}`
    const noteId = await seedNote(page, title, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    // No .hover() on the card itself: it's pointer-events:none (the canvas
    // beneath owns hit-testing), so Playwright's hover actionability check on
    // its bounding-box center times out. The ↗ button is the interactive
    // region and click() on it works directly, matching canvas-cards.e2e.ts.
    await card.getByRole('button', { name: 'Open in tab' }).click()
    await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })
    // The card did not enter active state from the ↗ click.
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active')
  })
})
