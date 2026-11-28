// Port of apps/desktop/tests/e2e/shared-sync-bootstrap.e2e.ts. Electron read the server URL from
// the main process's `SYNC_SERVER_URL`; here each app reports it through `e2e_app_info`.
import { expect, test } from '../../fixtures/sync-auth-fixtures'
import { appInfo } from '../../harness/tauri-lifecycle'
import type { Page } from '../../harness/pw-compat/page'

function triggerSync(page: Page): Promise<{ success: boolean; reason?: string; error?: string }> {
  return page.evaluate(
    () =>
      window.__TAURI__.core.invoke('sync_trigger') as Promise<{
        success: boolean
        reason?: string
        error?: string
      }>
  )
}

test.describe('Shared sync bootstrap', () => {
  test('bootstraps A and B so both can trigger sync', async ({
    app,
    appB,
    page,
    pageB,
    syncServerUrl,
    bootstrappedSyncPair: _bootstrappedSyncPair
  }) => {
    const serverUrlA = (await appInfo(app)).syncServerUrl
    const serverUrlB = (await appInfo(appB)).syncServerUrl

    expect(serverUrlA).toBe(syncServerUrl)
    expect(serverUrlB).toBe(syncServerUrl)

    const resultA = await triggerSync(page)
    const resultB = await triggerSync(pageB)

    expect(resultA.success).toBe(true)
    expect(resultB.success).toBe(true)
  })
})
