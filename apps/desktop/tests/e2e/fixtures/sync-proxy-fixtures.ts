/**
 * Sync fixtures that route both Electron profiles through a recording proxy.
 *
 * Same shared account and same real Worker as `sync-auth-fixtures`; the only
 * difference is that `syncServerUrl` points at the proxy, so a spec can assert
 * on what the client actually requested (429 pressure, chunk GETs, pack
 * listing) and interrupt a transfer mid-body.
 */

import { test as base, expect } from './sync-auth-fixtures'
import { startSyncProxy, type SyncProxy } from '../utils/sync-proxy'

export const test = base.extend<{ syncProxy: SyncProxy }>({
  syncProxy: async ({ syncBootstrap }, use) => {
    const proxy = await startSyncProxy(syncBootstrap.serverUrl)
    try {
      await use(proxy)
    } finally {
      await proxy.close()
    }
  },

  syncServerUrl: async ({ syncProxy }, use) => {
    await use(syncProxy.url)
  }
})

export { expect }
export { bootstrapSyncDevice } from './sync-auth-fixtures'
