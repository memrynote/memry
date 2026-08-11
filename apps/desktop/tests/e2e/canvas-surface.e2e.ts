// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M1 — canvas surface (local-only).
 *
 * The spatialCanvas flag defaults ON since the M7 rollout, so tests drive it
 * both ways through settings.setFeaturesSettings. Canvas pixels are not
 * assertable in Playwright; persistence is asserted through the scene JSON
 * returned by window.api.canvas.get (element count/type), per the design
 * spec (§18 B4).
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

/**
 * Persists the flag, then reloads so every useFeatureFlags mount reads the
 * new value on its initial fetch. The live settings:changed path is racy on
 * a cold boot (a fetch dispatched before the write can resolve after the
 * event and clobber it) — reload makes the flag state deterministic.
 */
async function setSpatialCanvasFlag(page: Page, enabled: boolean): Promise<void> {
  const result = await page.evaluate(
    async (value) => window.api.settings.setFeaturesSettings({ spatialCanvas: value }),
    enabled
  )
  if (!result?.success) {
    throw new Error(result?.error ?? 'setFeaturesSettings failed')
  }
  await page.reload()
  await openVault(page)
}

/** Parsed scene JSON for a canvas id, or null when the canvas is missing. */
async function getCanvasScene(page: Page, id: string) {
  return page.evaluate(async (canvasId) => {
    const canvas = await window.api.canvas.get(canvasId)
    if (!canvas) return null
    if (!canvas.scene) return { elements: [] }
    return JSON.parse(canvas.scene)
  }, id)
}

function liveElements(scene): Array<{ type: string }> {
  return (scene?.elements ?? []).filter((element) => !element.isDeleted)
}

async function createCanvasFromSidebar(page: Page): Promise<string> {
  const sectionHeader = page.getByRole('button', { name: /Canvases section/ })
  await expect(sectionHeader).toBeVisible()
  await sectionHeader.hover()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()

  // The editor tab opens on the freshly created canvas.
  await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20000 })

  const list = await page.evaluate(async () => window.api.canvas.list())
  expect(list.canvases.length).toBeGreaterThan(0)
  return list.canvases[0].id
}

test.describe('Spatial canvas — surface (M1)', () => {
  // Each test boots the app up to four times (initial + reload per flag write
  // + persistence reload) at ~25s per boot — the 60s default is short.
  test.describe.configure({ timeout: 300_000 })

  test('flag off shows no sidebar section; enabled: create, draw, reload persists ink', async ({
    page
  }) => {
    await openVault(page)

    // Flag off: zero user-visible change. Turned off explicitly — the default
    // has been ON since the M7 rollout, so the gate is only observable here.
    await setSpatialCanvasFlag(page, false)
    await expect(page.getByRole('button', { name: /Canvases section/ })).toHaveCount(0)

    await setSpatialCanvasFlag(page, true)
    const canvasId = await createCanvasFromSidebar(page)

    // Freedraw ink: focus the canvas, select the draw tool, multi-step drag.
    const box = await page.locator('[data-canvas-editor]').boundingBox()
    if (!box) throw new Error('canvas editor has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.click(cx, cy + 40)
    // Freedraw has two shortcuts (7 and X); pressing both is idempotent and
    // covers either binding without depending on toolbar DOM internals.
    await page.keyboard.press('7')
    await page.keyboard.press('x')
    await page.mouse.move(cx - 120, cy - 20)
    await page.mouse.down()
    await page.mouse.move(cx + 140, cy + 90, { steps: 14 })
    await page.mouse.up()

    // The debounced save lands in the data db (no reliance on quit-flush here).
    await expect
      .poll(async () => liveElements(await getCanvasScene(page, canvasId)).length, {
        timeout: 15000
      })
      .toBeGreaterThan(0)

    const before = liveElements(await getCanvasScene(page, canvasId))
    const freedrawCount = before.filter((element) => element.type === 'freedraw').length
    expect(freedrawCount).toBeGreaterThan(0)

    // Reload: flag + scene persist, the restored tab mounts the editor again.
    await page.reload()
    await openVault(page)

    const after = liveElements(await getCanvasScene(page, canvasId))
    expect(after.filter((element) => element.type === 'freedraw').length).toBe(freedrawCount)
    await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 20000 })
  })

  test('restored canvas tab shows a placeholder when the flag is off', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)

    // Tab restore cannot gate hidden-phase tabs ('canvas' is not in
    // FEATURE_KEYS) — the flag gate is CanvasPage's placeholder.
    // setSpatialCanvasFlag reloads, so the canvas tab is restored flag-off.
    await setSpatialCanvasFlag(page, false)

    await expect(page.locator('[data-canvas-placeholder]')).toBeVisible({ timeout: 20000 })
    await expect(page.locator('.excalidraw')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Canvases section/ })).toHaveCount(0)
  })
})
