// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M6 — in-place live editing. Double-click promotes ONE card to
 * active; click-away/Escape returns to idle. ↗ redirect stays distinct from
 * editing (matrix #20). Later tasks add note/task/event body assertions.
 */
import { test, expect, type Page } from './fixtures'
import { MOD, ready } from './utils/desktop-test-helpers'
import { setOpenPagesInNewTab } from './utils/electron-helpers'

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
/**
 * Focus a split-view pane by its data-pane-id. A real mouse click is
 * unreliable here: the tab bar is a `-webkit-app-region: drag` region
 * (tab-bar-with-drag.tsx) that swallows synthetic clicks, and the content
 * area below it is Excalidraw's own canvas. Dispatching a bubbling click
 * directly on the pane's root element lands exactly on tab-pane.tsx's
 * `onClick` (SET_ACTIVE_GROUP) without depending on what's rendered inside it.
 */
async function focusPane(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => {
    const pane = document.querySelector(`[data-testid="tab-pane"][data-pane-id="${id}"]`)
    pane?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, paneId)
}
/** Double-click the visual center of a card's overlay div. */
async function dblclickCard(page: Page, entity: string): Promise<void> {
  const box = await page.locator(`[data-canvas-card-entity="${entity}"]`).boundingBox()
  if (!box) throw new Error(`no card box for ${entity}`)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
}
/** Seed a task in the inbox (or first) project via the real tasks IPC. */
async function seedTask(page: Page, title: string): Promise<string> {
  const taskId = await page.evaluate(async (t) => {
    const projectsRes = await window.api.tasks.listProjects()
    const projectId = projectsRes.projects.find((p) => p.isInbox)?.id ?? projectsRes.projects[0]?.id
    if (!projectId) return null
    const res = await window.api.tasks.create({ title: t, projectId })
    return res.task?.id ?? null
  }, title)
  if (!taskId) throw new Error(`seedTask failed for ${title}`)
  return taskId
}
async function dropTask(page: Page, taskId: string): Promise<void> {
  await page.evaluate((id) => {
    const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
    const r = wrapper.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData(
      'application/x-memry-canvas-item',
      JSON.stringify({ entityType: 'task', entityId: id })
    )
    const ev = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    wrapper.dispatchEvent(ev)
  }, taskId)
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

  // M7 guard regression. The lock only triggers when the same note is live in
  // ANOTHER visible pane; a single-pane canvas can never reach that state
  // (tab-pane.tsx mounts only each group's active tab). So this asserts the
  // guard does NOT over-trigger and silently break M6's happy path. The
  // positive split-view case is covered below by a real split, driven by the
  // renderer-level ⌘\ / Ctrl+\ keyboard shortcut (use-tab-keyboard-shortcuts.ts)
  // — tabs.e2e.ts's `createHorizontalSplit` dispatches a `test:split-view`
  // CustomEvent that no renderer code listens for, but that is a gap in that
  // one helper, not a Playwright limitation: the keyboard shortcut is a plain
  // `window` keydown listener and drives a real SPLIT_VIEW dispatch.
  test('an unlocked note card still activates (M7 guard does not over-trigger)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const noteId = await seedNote(page, `Unlocked ${Date.now()}`, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).not.toHaveAttribute('data-canvas-card-locked', 'true')

    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
  })

  // Split-view co-edit, for real — and since #1504 the assertion is INVERTED.
  // This used to assert the lock, on the premise that an unauthenticated pair of
  // editors could not share a Y.Doc. `f89d23ed5` killed that premise and #1504
  // re-keyed the lock on the fragment: the tab's ContentArea binds the local
  // Y.Doc with no session at all, the card acquires that same registry entry, so
  // the whole-markdown save is suppressed on both and there is nothing to
  // clobber. This E2E vault is exactly the healthy signed-out population that
  // the old session predicate locked out for no hazard, so what it now pins is
  // that they can edit.
  //
  // Split with the renderer's own ⌘\ / Ctrl+\ shortcut
  // (use-tab-keyboard-shortcuts.ts registers a plain `window` keydown handler
  // for it — nothing native-menu-only about it), open the seeded note in the
  // newly-created pane so it becomes that pane's ACTIVE tab
  // (collectVisibleNoteTabIds only counts active tabs — tab-pane.tsx mounts only
  // each group's active tab), then refocus the canvas pane.
  //
  // The other side of the predicate — a settled binding with NO fragment, the
  // signed-in fail-open — is not reachable from here: it needs main's CRDT
  // provider to be down, which only `resetCrdtProvider()` does and which no
  // renderer-visible API can trigger. It is covered in
  // src/renderer/src/pages/canvas/use-note-edit-lock.test.tsx against the real
  // registry with the IPC provider faked.
  test('a note open in the split pane no longer locks the canvas card (shared local Y.Doc)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)
    const title = `Split Lock ${Date.now()}`
    const noteId = await seedNote(page, title, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })

    // The card being visible in the DOM only proves the React scene state
    // updated — CanvasEditor's persister debounces the actual save
    // (SCENE_SAVE_DEBOUNCE_MS). Poll the persisted scene itself before
    // splitting, exactly like the remount-regression test above does, so the
    // split can't race an in-flight save.
    const cardRectCount = async (): Promise<number> => {
      const c = await page.evaluate(async (id) => window.api.canvas.get(id), canvasId)
      const parsed = c?.scene ? JSON.parse(c.scene) : { elements: [] }
      return (parsed.elements ?? []).filter(
        (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId === noteId
      ).length
    }
    await expect.poll(cardRectCount, { timeout: 20000 }).toBe(1)

    // The canvas pane is the only (and therefore active) pane right now —
    // capture its id so it can be targeted precisely once a second pane exists.
    const canvasPaneId = await page
      .locator('[data-testid="tab-pane"]')
      .first()
      .getAttribute('data-pane-id')

    await page.keyboard.press(`${MOD}+\\`)
    await expect(page.locator('[data-testid="tab-pane"]')).toHaveCount(2, { timeout: 20000 })

    // SPLIT_VIEW clones the active (canvas) tab into the new pane and leaves
    // activeGroupId untouched (layout-reducer.ts), so the new pane is the one
    // NOT currently active — identify it that way rather than by DOM order.
    // Read its data-pane-id once, up front: a locator keyed on
    // data-pane-active="false" would start matching the OTHER pane the
    // instant this one's focus flips to true.
    const newPaneId = await page
      .locator('[data-testid="tab-pane"][data-pane-active="false"]')
      .getAttribute('data-pane-id')
    const newPane = page.locator(`[data-testid="tab-pane"][data-pane-id="${newPaneId}"]`)
    await focusPane(page, newPaneId!)
    await expect(newPane).toHaveAttribute('data-pane-active', 'true')

    // Open the seeded note in the now-focused new pane via the same test-only
    // hook note-sync-helpers.ts uses (App.tsx's openTab has no groupId, so it
    // targets whichever pane is currently focused).
    await page.evaluate(
      ({ id, t }) => {
        window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail: { id, title: t } }))
      },
      { id: noteId, t: title }
    )
    await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })
    // The new pane's own (cloned) canvas tab is now a background tab there, so
    // its CanvasPage unmounts — wait for that before touching card locators,
    // since until it does there are transiently two DOM nodes for this same
    // card (one per pane, both rendering the same underlying canvas).
    await expect(page.locator('[data-canvas-editor]')).toHaveCount(1, { timeout: 20000 })

    // Refocus the canvas pane.
    await focusPane(page, canvasPaneId!)
    const canvasPane = page.locator(`[data-testid="tab-pane"][data-pane-id="${canvasPaneId}"]`)
    await expect(canvasPane).toHaveAttribute('data-pane-active', 'true')

    // The card is not locked, and double-click really does activate it — both,
    // because "no lock badge" alone would also be true of a card the overlay
    // silently refuses to activate.
    await expect(card).not.toHaveAttribute('data-canvas-card-locked', 'true')
    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    // And the edit made on the card while the note is live in the other pane
    // lands exactly once — the clobber the lock existed to prevent would show up
    // here as a lost or duplicated marker.
    const marker = `SPLITEDIT_${Date.now()}`
    const cardEditor = page.locator('[data-canvas-active-card] [contenteditable="true"]').first()
    await cardEditor.click()
    await cardEditor.pressSequentially(` ${marker}`, { delay: 20 })
    await expect
      .poll(
        async () => {
          const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
          return (note?.content?.match(new RegExp(marker, 'g')) ?? []).length
        },
        { timeout: 20000 }
      )
      .toBe(1)
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
    // Tabs are reused by default, so the canvas would replace the Home tab this
    // test switches to. Give each opened page its own tab.
    await setOpenPagesInNewTab(page, true)
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

  // Matrix #19 — sequential consistency, no duplicate/echo, in a SINGLE pane:
  // switching to the note tab unmounts the canvas (tab-content renders only the
  // active tab), so the two editors here are sequential, not simultaneous. (The
  // simultaneous split-view case is the co-edit test above; since `f89d23ed5`
  // both editors bind the local Y.Doc even with no session.)
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

  test('double-click a task card edits fields in place; persists via tasks IPC (matrix #22 task)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const taskId = await seedTask(page, `Canvas Task ${Date.now()}`)
    await dropTask(page, taskId)

    const card = page.locator(`[data-canvas-card-entity="task:${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await dblclickCard(page, `task:${taskId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    const newTitle = `Renamed ${Date.now()}`
    const titleInput = page.locator('[data-canvas-active-card] input[data-canvas-task-title]')
    await titleInput.fill(newTitle)
    await page.mouse.click(10, 10)

    await expect
      .poll(
        async () => {
          const t = await page.evaluate(async (id) => window.api.tasks.get(id), taskId)
          return t?.title ?? ''
        },
        { timeout: 20000 }
      )
      .toBe(newTitle)
  })

  test('double-click an event card edits it in place; persists via calendar IPC (matrix #22 event)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const eventId = await page.evaluate(async () => {
      const start = new Date()
      start.setHours(10, 0, 0, 0)
      const res = await window.api.calendar.createEvent({
        title: 'Canvas Event',
        startAt: start.toISOString(),
        isAllDay: false,
        timezone: 'UTC'
      })
      return res.event?.id ?? ''
    })
    await page.evaluate((id) => {
      const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
      const r = wrapper.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData(
        'application/x-memry-canvas-item',
        JSON.stringify({ entityType: 'calendar_event', entityId: id })
      )
      const ev = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      wrapper.dispatchEvent(ev)
    }, eventId)

    const card = page.locator(`[data-canvas-card-entity="calendar_event:${eventId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await dblclickCard(page, `calendar_event:${eventId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    const newTitle = `Event ${Date.now()}`
    await page.locator('[data-canvas-active-card] input').first().fill(newTitle)
    // Save fires on pointerdown (calendar form pattern).
    await page.getByRole('button', { name: /Save/ }).click()

    await expect
      .poll(
        async () => {
          const e = await page.evaluate(async (id) => window.api.calendar.getEvent(id), eventId)
          return e?.title ?? ''
        },
        { timeout: 20000 }
      )
      .toBe(newTitle)
  })

  test('40-card canvas with one active editor: off-screen cards unmount (matrix #16/#21)', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)
    const noteId = await seedNote(page, `Perf ${Date.now()}`, 'body')
    for (let i = 0; i < 40; i++) {
      await dropNote(page, noteId, (i % 8) * 320 - 1200, Math.floor(i / 8) * 220 - 500)
    }
    // Activate one card via a raw mouse dblclick at its bounding-box center
    // (mirrors dblclickCard()): cards are pointer-events:none previews — the
    // wrapper's capture-phase dblclick listener does its own hit-test — so
    // Playwright's locator.dblclick() actionability check is the wrong tool
    // here. The 40-card grid deliberately spans well beyond the viewport (to
    // force virtualization), so a mounted (enter-padding-widened) card can
    // still be clipped outside the visible canvas rect — only pick a card
    // whose center actually falls inside the canvas wrapper, with a margin
    // clear of the fixed window-chrome strip, so the click always lands on
    // canvas and never on the tab bar / sidebar behind it.
    const wrapperBox = await page.locator('[data-canvas-editor]').boundingBox()
    if (!wrapperBox) throw new Error('no canvas wrapper box')
    const margin = 40
    const safeLeft = wrapperBox.x + margin
    const safeTop = Math.max(wrapperBox.y, 60) + margin
    const safeRight = wrapperBox.x + wrapperBox.width - margin
    const safeBottom = wrapperBox.y + wrapperBox.height - margin
    const cardLoc = page.locator('[data-canvas-card-id]')
    const mountedBefore = await cardLoc.count()
    let activated = false
    for (let i = 0; i < mountedBefore; i++) {
      const box = await cardLoc.nth(i).boundingBox()
      if (!box) continue
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      if (cx < safeLeft || cx > safeRight || cy < safeTop || cy > safeBottom) continue
      await page.mouse.dblclick(cx, cy)
      activated = true
      break
    }
    if (!activated) throw new Error('no clickable card found within the visible canvas rect')
    await expect(page.locator('[data-canvas-active-card]')).toHaveCount(1, { timeout: 20000 })

    // Scene persistence is debounced — poll until all 40 drops have flushed
    // to disk (mirrors cardRectCount in the remount-regression test above).
    const cardRectTotal = async (): Promise<number> => {
      const c = await page.evaluate(async (id) => window.api.canvas.get(id), canvasId)
      const parsed = c?.scene ? JSON.parse(c.scene) : { elements: [] }
      return (parsed.elements ?? []).filter(
        (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId
      ).length
    }
    await expect.poll(cardRectTotal, { timeout: 20000 }).toBeGreaterThanOrEqual(40)
    const total = await cardRectTotal()
    const mounted = await page.locator('[data-canvas-card-id]').count()
    expect(mounted).toBeLessThan(total)
    // Exactly one active editor.
    expect(await page.locator('[data-canvas-active-card]').count()).toBe(1)
  })

  // PR #899 headline invariant: a card renders at full editor fidelity in BOTH
  // states; double-click only toggles writability. Activating must therefore
  // not resize or move the card — the regression guard against the old
  // preview→editor swap that reflowed the card on activation.
  test('double-click does not shift a note card (zero layout shift)', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const noteId = await seedNote(
      page,
      `NoShift ${Date.now()}`,
      '# Heading\n\nSome body text that gives the card real height.\n\n- one\n- two'
    )
    await dropNote(page, noteId)
    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).toHaveAttribute('data-canvas-card-state', 'ready', { timeout: 20000 })

    const idleBox = await card.boundingBox()
    if (!idleBox) throw new Error('no idle card box')
    await page.screenshot({ path: 'test-results/live-cards/note-idle.png' })

    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    const activeBox = await card.boundingBox()
    if (!activeBox) throw new Error('no active card box')
    await page.screenshot({ path: 'test-results/live-cards/note-active.png' })

    // Same geometry within a sub-pixel tolerance: activation toggles
    // writability, not size or position.
    expect(Math.abs(activeBox.x - idleBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(activeBox.y - idleBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(activeBox.width - idleBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(activeBox.height - idleBox.height)).toBeLessThanOrEqual(1)
  })

  // The reported bug: an idle note card showed raw {task:<id>} markers as plain
  // text. Cards now share the editor's markdown load chain (normalize-note-
  // blocks), so an inline task marker renders as the task block, and the linked
  // task's live title resolves through TaskPrefetchProvider.
  test('a note card renders {task:} markers as task blocks, not raw text', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const taskTitle = `Linked ${Date.now()}`
    const taskId = await seedTask(page, taskTitle)
    const noteId = await seedNote(
      page,
      `Markers ${Date.now()}`,
      `# Notes\n\n- [ ] ${taskTitle} {task:${taskId}}`
    )
    await dropNote(page, noteId)
    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).toHaveAttribute('data-canvas-card-state', 'ready', { timeout: 20000 })

    // The inline {task:} marker renders as a real task block (a taskBlock DOM
    // node from the shared load chain), not raw text. Structural, so it does
    // not race the linked task's async live-title resolution.
    await expect(card.locator('[data-content-type="taskBlock"]')).toBeVisible({ timeout: 20000 })
    // The heading renders too, proving the body loaded at editor fidelity.
    await expect(card).toContainText('Notes', { timeout: 20000 })
    await page.screenshot({ path: 'test-results/live-cards/note-task-marker.png' })
    // …and the raw marker never leaks as plain text — the reported bug.
    await expect(card).not.toContainText('{task:')
  })
})
