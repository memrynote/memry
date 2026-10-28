// The compact picker window and its transition to the app window (inv09#2).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { invoke, vaultStatus } from '../../harness/vault-commands'

interface E2eWindow {
  label: string
  width: number
  height: number
  visible: boolean
}

const mainWindow = async (app: Parameters<typeof invokeTest>[0]): Promise<E2eWindow> => {
  const windows = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
  return windows.find((window) => window.label === 'main')!
}

test.describe('picker', () => {
  test.use({ extraEnv: { MEMRY_FORCE_VAULT_PICKER: '1' }, keepWindowRect: true })

  test('opens at 900x720, grows when a vault opens and shrinks when it closes', async ({
    app,
    page,
    testVaultPath
  }) => {
    await expect.poll(async () => (await mainWindow(app)).visible, { timeout: 30_000 }).toBe(true)
    // The OS shrinks a window that does not fit its screen (hosted macOS runners are 1024x768),
    // so the picker is at most 900x720 and the exact size is held only where it fits.
    const avail = await page.evaluate(() => [screen.availWidth, screen.availHeight])
    const fits = (width: number, height: number): boolean =>
      avail[0] >= width + 100 && avail[1] >= height + 100
    const picker = await mainWindow(app)
    expect(picker.width).toBeLessThanOrEqual(900)
    expect(picker.height).toBeLessThanOrEqual(720)
    if (fits(900, 720)) expect(picker).toMatchObject({ width: 900, height: 720 })

    await page.getByText(testVaultPath).click()
    await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(async () => {
        const { width, height } = await mainWindow(app)
        const grown = fits(1550, 900)
          ? width === 1550 && height === 900
          : width > picker.width || height > picker.height
        return grown
          ? 'grown'
          : `${width}x${height} from ${picker.width}x${picker.height} on ${avail}`
      })
      .toBe('grown')

    await invoke(page, 'vault_close')
    await expect
      .poll(async () => {
        const { width, height } = await mainWindow(app)
        return [width, height]
      })
      .toEqual([picker.width, picker.height])
  })

  // The window is frameless on Windows: without its own buttons the picker can't be closed or
  // maximized from the title row.
  test('the picker has the Windows caption buttons at the physical right edge', async ({
    app,
    page
  }) => {
    test.skip(process.platform !== 'win32', 'caption buttons are Windows-only')
    await expect.poll(async () => (await mainWindow(app)).visible, { timeout: 30_000 }).toBe(true)

    const close = page.locator('[data-caption-button="close"]')
    await expect(close).toBeVisible()
    const box = (await close.boundingBox())!
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(Math.abs(box.x + box.width - viewportWidth)).toBeLessThanOrEqual(1)
    await expect(page.locator('[data-caption-button]')).toHaveCount(3)
  })
})
