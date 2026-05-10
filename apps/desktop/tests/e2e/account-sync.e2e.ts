import { test, expect } from './fixtures/sync-auth-fixtures'

test.describe('Account sync E2E', () => {
  test('shows bootstrapped account devices and signs out through account IPC', async ({
    pageA,
    syncBootstrap,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const before = await pageA.evaluate(async () => {
      return {
        account: await window.api.account.getInfo(),
        devices: await window.api.syncDevices.getDevices()
      }
    })

    expect(before.account.email).toBe(syncBootstrap.email)
    expect(before.account.joinedAt).toEqual(expect.any(Number))
    expect(before.devices.email).toBe(syncBootstrap.email)
    expect(before.devices.devices.some((device) => device.isCurrentDevice)).toBe(true)

    const signOut = await pageA.evaluate(() => window.api.account.signOut())
    expect(signOut.success).toBe(true)

    const after = await pageA.evaluate(() => window.api.account.getInfo())
    expect(after).toEqual({ email: null, joinedAt: null })
  })

  test('revokes another device and forces that device to re-authenticate', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const [deviceA, deviceB] = await Promise.all([
      pageA.evaluate(async () => {
        const devices = await window.api.syncDevices.getDevices()
        return {
          current: devices.devices.find((device) => device.isCurrentDevice)?.id ?? null,
          remote: devices.devices.find((device) => !device.isCurrentDevice)?.id ?? null
        }
      }),
      pageB.evaluate(async () => {
        const devices = await window.api.syncDevices.getDevices()
        return {
          current: devices.devices.find((device) => device.isCurrentDevice)?.id ?? null
        }
      })
    ])
    expect(deviceA.current).toBeTruthy()
    expect(deviceA.remote).toBe(deviceB.current)

    const revoke = await pageA.evaluate(
      (deviceId) => window.api.syncDevices.removeDevice({ deviceId }),
      deviceA.remote!
    )
    expect(revoke.success).toBe(true)

    await expect(
      pageA.getByRole('alertdialog').filter({ hasText: 'This device has been removed' })
    ).toHaveCount(0)

    await pageB.evaluate(() => window.api.syncOps.triggerSync())

    await expect(
      pageB.getByRole('alertdialog').filter({ hasText: 'This device has been removed' })
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        () =>
          pageB.evaluate(async () => {
            const status = await window.api.syncOps.getStatus()
            return {
              status: status.status,
              errorCategory: status.errorCategory
            }
          }),
        { timeout: 30_000 }
      )
      .toMatchObject({
        status: 'error',
        errorCategory: 'device_revoked'
      })

    await pageB.getByRole('button', { name: 'Sign Out' }).click()
    await expect(pageB.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(() => pageB.evaluate(() => window.api.account.getInfo()))
      .toEqual({ email: null, joinedAt: null })
    await expect(pageB.getByRole('button', { name: 'Sync disabled' })).toBeVisible()

    await pageB.getByRole('button', { name: 'Sync disabled' }).click()
    await expect(pageB.getByText('Set up Sync')).toBeVisible()
  })
})
