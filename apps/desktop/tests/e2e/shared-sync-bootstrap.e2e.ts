import { test, expect } from './fixtures/sync-auth-fixtures'

test.describe('Shared sync bootstrap', () => {
  test(
    'bootstraps A and B so both can trigger sync',
    async ({ electronAppA, electronAppB, pageA, pageB, syncServerUrl, bootstrappedSyncPair }) => {
      void bootstrappedSyncPair

      const serverUrlA = await electronAppA.evaluate(() => process.env.SYNC_SERVER_URL ?? null)
      const serverUrlB = await electronAppB.evaluate(() => process.env.SYNC_SERVER_URL ?? null)

      expect(serverUrlA).toBe(syncServerUrl)
      expect(serverUrlB).toBe(syncServerUrl)

    const resultA = await pageA.evaluate(() => window.api.syncOps.triggerSync())
    const resultB = await pageB.evaluate(() => window.api.syncOps.triggerSync())

    expect(resultA.success).toBe(true)
    expect(resultB.success).toBe(true)
    }
  )
})
