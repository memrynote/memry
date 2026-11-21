// Port of apps/desktop/tests/e2e/network-control.e2e.ts: both devices of one account go offline
// through `e2e_set_network_online` and come back, read through `sync_get_status`.
import { expect, test } from '../../fixtures/sync-auth-fixtures'
import { invoke } from '../../harness/vault-commands'
import {
  goOffline,
  goOnline,
  waitForSyncOffline,
  waitForSyncOnline
} from '../../harness/network-control'

interface TriggerSyncResult {
  success: boolean
}

test.describe('Network control', () => {
  test('transitions both devices online -> offline -> online', async ({
    app,
    appB,
    page,
    pageB,
    bootstrappedSyncPair: _bootstrappedSyncPair
  }) => {
    const [triggerA, triggerB] = await Promise.all([
      invoke<TriggerSyncResult>(page, 'sync_trigger'),
      invoke<TriggerSyncResult>(pageB, 'sync_trigger')
    ])

    expect(triggerA.success).toBe(true)
    expect(triggerB.success).toBe(true)

    await waitForSyncOnline(page)
    await waitForSyncOnline(pageB)

    await goOffline(app, appB)

    const [offlineStatusA, offlineStatusB] = await Promise.all([
      waitForSyncOffline(page),
      waitForSyncOffline(pageB)
    ])

    expect(offlineStatusA.offlineSince).toBeDefined()
    expect(offlineStatusB.offlineSince).toBeDefined()

    await goOnline(app, appB)

    const [onlineStatusA, onlineStatusB] = await Promise.all([
      waitForSyncOnline(page),
      waitForSyncOnline(pageB)
    ])

    expect(onlineStatusA.offlineSince).toBeUndefined()
    expect(onlineStatusB.offlineSince).toBeUndefined()
  })
})
