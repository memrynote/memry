import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { destroyLaunchedElectron, launchElectronWithWindow } from './utils/electron-lifecycle'

function readZoomFactor(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
  )
}

/**
 * The share of the window covered by the sidebar.
 *
 * Zoom divides the CSS-pixel viewport while the sidebar keeps its CSS width, so
 * this share rises in direct proportion to the zoom factor. It is the measure
 * that actually answers "did the interface get bigger on screen", which a
 * bounding box in CSS pixels alone cannot.
 */
function sidebarShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="app-sidebar"]')
    if (!sidebar) throw new Error('sidebar not rendered')
    return sidebar.getBoundingClientRect().width / window.innerWidth
  })
}

test.describe('Whole-UI zoom', () => {
  test('scales the rendered interface, not just the stored value', async ({
    page,
    electronApp
  }) => {
    await ready(page)

    expect(await readZoomFactor(electronApp)).toBe(1)
    const baselineShare = await sidebarShare(page)
    const baselineWidth = await page.evaluate(() => window.innerWidth)

    await page.evaluate(() => window.api.uiZoom.set(1.5))
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(1.5, 2)

    const zoomedShare = await sidebarShare(page)
    const zoomedWidth = await page.evaluate(() => window.innerWidth)

    // Same window, 1.5x the scale: the CSS viewport shrinks by 1.5 and the
    // sidebar therefore covers 1.5x as much of it.
    expect(zoomedShare / baselineShare).toBeCloseTo(1.5, 1)
    expect(baselineWidth / zoomedWidth).toBeCloseTo(1.5, 1)
  })

  test('applies a zoom chosen in Settings', async ({ page, electronApp }) => {
    await ready(page)

    await page.evaluate(() => window.api.quickCapture.openSettings('appearance'))
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByTestId('appearance-zoom-select').click()
    await page.getByRole('option', { name: '150%' }).click()

    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(1.5, 2)
  })

  test('keeps the zoom across a reload', async ({ page, electronApp }) => {
    await ready(page)
    await page.evaluate(() => window.api.uiZoom.set(1.75))
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(1.75, 2)

    await page.reload()
    await ready(page)

    // did-finish-load re-applies it: Chromium resets the factor on a new document.
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(1.75, 2)
    expect(await page.evaluate(() => window.api.uiZoom.get())).toBe(1.75)
  })

  test('clamps a request outside the ladder', async ({ page, electronApp }) => {
    await ready(page)

    expect(await page.evaluate(() => window.api.uiZoom.set(99))).toBe(2)
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(2, 2)

    expect(await page.evaluate(() => window.api.uiZoom.set(0.01))).toBe(0.75)
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(0.75, 2)
  })

  test('holds the layout together at both ends of the ladder', async ({ page }) => {
    await ready(page)

    const observed: Array<{ factor: number; innerWidth: number; sidebar: boolean; home: boolean }> =
      []

    for (const factor of [0.75, 2]) {
      await page.evaluate((f) => window.api.uiZoom.set(f), factor)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).not.toBe(0)
      observed.push(
        await page.evaluate(() => ({
          factor: 0,
          innerWidth: window.innerWidth,
          sidebar: !!document.querySelector('[data-testid="app-sidebar"]'),
          home: document.body.textContent !== ''
        }))
      )
      observed[observed.length - 1].factor = factor
    }

    const [zoomedOut, zoomedIn] = observed
    // Zooming out widens the CSS viewport and zooming in narrows it, which is
    // what moves responsive breakpoints under the layout.
    expect(zoomedOut.innerWidth).toBeGreaterThan(zoomedIn.innerWidth)
    for (const state of observed) {
      expect(state.sidebar, `sidebar missing at ${state.factor}x`).toBe(true)
      expect(state.home, `app rendered nothing at ${state.factor}x`).toBe(true)
    }

    console.log('[ui-zoom] viewport at the extremes:', JSON.stringify(observed))
  })

  test('keeps the zoom across an app relaunch', async ({ testVaultPath }) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-zoom-relaunch-'))

    try {
      const first = await launchElectronWithWindow({ testVaultPath, userDataDir })
      await ready(first.page)
      await first.page.evaluate(() => window.api.uiZoom.set(1.75))
      await expect.poll(() => readZoomFactor(first.app)).toBeCloseTo(1.75, 2)
      await destroyLaunchedElectron(first)

      const second = await launchElectronWithWindow({ testVaultPath, userDataDir })
      try {
        await ready(second.page)
        // Device-local: the factor comes back from memry-config.json in userData,
        // which is why this is a relaunch assertion and not a vault reopen.
        await expect.poll(() => readZoomFactor(second.app)).toBeCloseTo(1.75, 2)
        expect(await second.page.evaluate(() => window.api.uiZoom.get())).toBe(1.75)
      } finally {
        await destroyLaunchedElectron(second)
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
