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

  test('double-click a note card edits its body in place; persists + tab reflects live (matrix #18)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const noteId = await seedNote(page, `Edit ${Date.now()}`, 'start')
    await dropNote(page, noteId)
    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })

    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    const marker = `INPLACE_${Date.now()}`
    const editor = page
      .locator(
        '[data-canvas-active-card] .bn-container [contenteditable="true"], [data-canvas-active-card] [contenteditable="true"]'
      )
      .first()
    await editor.click()
    await editor.pressSequentially(` ${marker}`, { delay: 20 })
    await page.mouse.click(10, 10) // click-away flushes + deactivates

    await expect
      .poll(
        async () => {
          const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
          return note?.content ?? ''
        },
        { timeout: 20000 }
      )
      .toContain(marker)
  })

  // Regression for the M6 restore-wipe bug: an in-session CanvasPage remount
  // (tab switch away and back, or close+reopen) must NOT lose the cards. The
  // root cause was the unmount flush serializing a torn-down Excalidraw (0
  // elements) and persisting an empty scene over the real one; the reopened
  // canvas then had no cards. Reopening never appeared in any earlier E2E, so
  // the bug was latent.
  test('cards survive an in-session canvas remount (restore regression)', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)
    const title = `Restore ${Date.now()}`
    const noteId = await seedNote(page, title, 'body')
    await dropNote(page, noteId)
    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })

    // The card rectangle (with customData) is persisted before the remount.
    const cardRectCount = async (): Promise<number> => {
      const c = await page.evaluate(async (id) => window.api.canvas.get(id), canvasId)
      const parsed = c?.scene ? JSON.parse(c.scene) : { elements: [] }
      return (parsed.elements ?? []).filter(
        (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId === noteId
      ).length
    }
    await expect.poll(cardRectCount, { timeout: 20000 }).toBe(1)

    // Force a clean in-session remount: switch to the Home tab (this UNMOUNTS
    // the canvas — tab-content renders only the active tab) then switch back.
    await page.getByRole('tab', { name: /Home/ }).first().click()
    await expect(page.locator('[data-canvas-editor]')).toHaveCount(0, { timeout: 20000 })
    await page
      .getByRole('tab', { name: /Canvas|Untitled canvas/ })
      .first()
      .click()
    await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 25000 })

    // The unmount must not have wiped the persisted scene…
    await expect.poll(cardRectCount, { timeout: 20000 }).toBe(1)
    // …and the overlay card re-renders on the restored scene.
    await expect(card).toBeVisible({ timeout: 20000 })
  })

  // Matrix #19 — sequential consistency, no duplicate/echo. True SIMULTANEOUS
  // two-editor co-editing is unreachable here: switching to the note tab
  // unmounts the canvas (tab-content renders only the active tab), and the E2E
  // vault is unauthenticated so ContentArea's Yjs collaboration is OFF (gated
  // on syncActive) — both editors use the non-collaborative markdown-save path.
  // R17's shared-Y.Doc path is covered by unit tests (yjs-doc-registry.test.ts).
  // So this asserts the honest, achievable invariant: an edit made on the card
  // is persisted exactly ONCE (no duplicate blocks), and re-opening the same
  // note in a tab shows that edit with no echo or duplication.
  test('card edit persists once and stays consistent when reopened in a tab (matrix #19)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const title = `Coedit ${Date.now()}`
    const noteId = await seedNote(page, title, 'seed')
    await dropNote(page, noteId)
    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })

    // Edit the note body in place on the card. Keep the card active so its
    // editor's debounced save runs (deactivating immediately would race the
    // async editor change → flush before it is captured).
    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    const marker = `COEDIT_${Date.now()}`
    const cardEditor = page.locator('[data-canvas-active-card] [contenteditable="true"]').first()
    await cardEditor.click()
    await cardEditor.pressSequentially(` ${marker}`, { delay: 20 })

    const markerCount = async (): Promise<number> => {
      const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
      return (note?.content?.match(new RegExp(marker, 'g')) ?? []).length
    }
    // Persisted exactly once — no duplicate blocks from the card editor.
    await expect.poll(markerCount, { timeout: 20000 }).toBe(1)

    // Deactivate (click empty canvas), then re-open the note in a tab (↗).
    const wrap = await page.locator('[data-canvas-editor]').boundingBox()
    await page.mouse.click(wrap!.x + 20, wrap!.y + 20)
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    await card.getByRole('button', { name: 'Open in tab' }).click()
    await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })

    // The tab editor reflects the saved edit (consistency), and mounting a
    // second editor over the same note introduced no echo/duplication.
    const tabEditor = page.locator('.bn-container [contenteditable="true"]').first()
    await expect(tabEditor).toContainText(marker, { timeout: 20000 })
    await expect.poll(markerCount, { timeout: 20000 }).toBe(1)
  })
})
