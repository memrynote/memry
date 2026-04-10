import { test, expect } from './fixtures/sync-auth-fixtures'
import { goOffline, goOnline, waitForSyncOffline, waitForSyncOnline } from './utils/network-control'

test.describe('Network control', () => {
  test('transitions both devices online -> offline -> online', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair

    const [triggerA, triggerB] = await Promise.all([
      pageA.evaluate(() => window.api.syncOps.triggerSync()),
      pageB.evaluate(() => window.api.syncOps.triggerSync())
    ])

    expect(triggerA.success).toBe(true)
    expect(triggerB.success).toBe(true)

    await waitForSyncOnline(pageA)
    await waitForSyncOnline(pageB)

    await goOffline(electronAppA, electronAppB)

    const [offlineStatusA, offlineStatusB] = await Promise.all([
      waitForSyncOffline(pageA),
      waitForSyncOffline(pageB)
    ])

    expect(offlineStatusA.offlineSince).toBeDefined()
    expect(offlineStatusB.offlineSince).toBeDefined()

    await goOnline(electronAppA, electronAppB)

    const [onlineStatusA, onlineStatusB] = await Promise.all([
      waitForSyncOnline(pageA),
      waitForSyncOnline(pageB)
    ])

    expect(onlineStatusA.offlineSince).toBeUndefined()
    expect(onlineStatusB.offlineSince).toBeUndefined()
  })
})
