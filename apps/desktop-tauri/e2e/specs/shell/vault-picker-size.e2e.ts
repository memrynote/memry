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
    expect(await mainWindow(app)).toMatchObject({ width: 900, height: 720 })

    await page.getByText(testVaultPath).click()
    await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(async () => {
        const { width, height } = await mainWindow(app)
        return [width, height]
      })
      .toEqual([1550, 900])

    await invoke(page, 'vault_close')
    await expect
      .poll(async () => {
        const { width, height } = await mainWindow(app)
        return [width, height]
      })
      .toEqual([900, 720])
  })
})
