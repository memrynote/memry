import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

interface WindowState {
  exists: boolean
  destroyed: boolean
  visible: boolean
}

test.describe('Minimize to tray E2E', () => {
  test('the setting round-trips through main, including back to off', async ({ page }) => {
    await ready(page)

    const states = await page.evaluate(async () => {
      const api = window.api

      const enable = await api.settings.setGeneralSettings({ minimizeToTray: true })
      if (!enable.success) throw new Error(enable.error ?? 'enabling minimizeToTray failed')
      const enabled = await api.settings.getGeneralSettings()

      const disable = await api.settings.setGeneralSettings({ minimizeToTray: false })
      if (!disable.success) throw new Error(disable.error ?? 'disabling minimizeToTray failed')
      const disabled = await api.settings.getGeneralSettings()

      return { enabled: enabled.minimizeToTray, disabled: disabled.minimizeToTray }
    })

    expect(states.enabled).toBe(true)
    // The value that a truthiness check would swallow.
    expect(states.disabled).toBe(false)
  })

  test('closing the window with the setting on hides it instead of destroying it', async ({
    page,
    electronApp
  }) => {
    // Whether a tray icon can be created on Linux depends on the desktop session
    // having a StatusNotifier host, which CI's headless Ubuntu does not. Without
    // a tray the app deliberately keeps its normal close behavior, so there is
    // nothing to assert here. The same path is covered on every platform by
    // src/main/tray.test.ts.
    test.skip(process.platform === 'linux', 'tray availability is not guaranteed on Linux')

    await ready(page)

    const enabled = await page.evaluate(async () => {
      const result = await window.api.settings.setGeneralSettings({ minimizeToTray: true })
      if (!result.success) throw new Error(result.error ?? 'enabling minimizeToTray failed')
      return (await window.api.settings.getGeneralSettings()).minimizeToTray
    })
    expect(enabled).toBe(true)

    const afterClose = await electronApp.evaluate<WindowState>(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) throw new Error('no live window to close')
      window.close()
      await new Promise((resolve) => setTimeout(resolve, 250))
      return {
        exists: true,
        destroyed: window.isDestroyed(),
        visible: window.isDestroyed() ? false : window.isVisible()
      }
    })

    expect(afterClose.destroyed).toBe(false)
    expect(afterClose.visible).toBe(false)

    const afterRestore = await electronApp.evaluate<WindowState>(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) throw new Error('window was destroyed instead of hidden')
      window.show()
      await new Promise((resolve) => setTimeout(resolve, 250))
      return { exists: true, destroyed: window.isDestroyed(), visible: window.isVisible() }
    })

    expect(afterRestore.visible).toBe(true)

    // The renderer survived the hide/show, so this is the same window rather
    // than a replacement, and the app is usable again.
    await expect(page.locator('body')).toBeVisible()

    await page.evaluate(async () => {
      await window.api.settings.setGeneralSettings({ minimizeToTray: false })
    })
  })
})
