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

/** The OS window size, which zoom must not change. */
function readWindowWidth(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds().width)
}

/**
 * What the renderer is actually laying out into.
 *
 * `body`'s bounding box is in CSS pixels, and zoom divides the CSS-pixel
 * viewport. Read together with an unchanged OS window width, a box that shrinks
 * by the factor is the proof that every CSS pixel now covers proportionally
 * more of the screen — which is what "the interface got bigger" means.
 * devicePixelRatio scales with the same factor and is the direct confirmation.
 */
function readLayout(page: Page): Promise<{ boxWidth: number; dpr: number }> {
  return page.evaluate(() => ({
    boxWidth: document.body.getBoundingClientRect().width,
    dpr: window.devicePixelRatio
  }))
}

test.describe('Whole-UI zoom', () => {
  test('scales the rendered interface, not just the stored value', async ({
    page,
    electronApp
  }) => {
    await ready(page)

    expect(await readZoomFactor(electronApp)).toBe(1)
    const baseline = await readLayout(page)
    const windowWidth = await readWindowWidth(electronApp)

    await page.evaluate(() => window.api.uiZoom.set(1.5))
    await expect.poll(() => readZoomFactor(electronApp)).toBeCloseTo(1.5, 2)
    await expect.poll(async () => (await readLayout(page)).dpr).toBeCloseTo(baseline.dpr * 1.5, 1)

    const zoomed = await readLayout(page)

    // The OS window never moved, so the same physical width now holds 1.5x
    // fewer CSS pixels: everything drawn in it is 1.5x bigger on screen.
    expect(await readWindowWidth(electronApp)).toBe(windowWidth)
    expect(baseline.boxWidth / zoomed.boxWidth).toBeCloseTo(1.5, 1)
    expect(zoomed.dpr / baseline.dpr).toBeCloseTo(1.5, 1)
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

    const observed: Array<{
      factor: number
      innerWidth: number
      breakpoint: string
      rendered: boolean
    }> = []
    const baseDpr = await page.evaluate(() => window.devicePixelRatio)

    for (const factor of [0.75, 2]) {
      await page.evaluate((f) => window.api.uiZoom.set(f), factor)
      await expect
        .poll(() => page.evaluate(() => window.devicePixelRatio))
        .toBeCloseTo(baseDpr * factor, 1)
      const state = await page.evaluate(() => {
        const width = window.innerWidth
        const breakpoint =
          width >= 1280
            ? 'xl'
            : width >= 1024
              ? 'lg'
              : width >= 768
                ? 'md'
                : width >= 640
                  ? 'sm'
                  : 'base'
        return {
          innerWidth: width,
          breakpoint,
          rendered: (document.body.textContent ?? '').trim().length > 0
        }
      })
      observed.push({ factor, ...state })
    }

    const [zoomedOut, zoomedIn] = observed
    // Zooming out widens the CSS viewport and zooming in narrows it, which is
    // exactly what drags responsive breakpoints under an unchanged layout.
    expect(zoomedOut.innerWidth).toBeGreaterThan(zoomedIn.innerWidth)
    for (const state of observed) {
      expect(state.rendered, `app rendered nothing at ${state.factor}x`).toBe(true)
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
