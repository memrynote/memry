// Port of apps/desktop/tests/e2e/dual-device-isolation.e2e.ts. Instance A opens `testVaultPath`
// (Electron's `vaultPathA`) and instance B opens `vaultPathB`.
import { expect, test } from '../../fixtures/sync-fixtures'
import { vaultStatus } from '../../harness/vault-commands'

test.describe('Dual-device isolation', () => {
  test('launches A and B with separate vaults', async ({
    page,
    pageB,
    testVaultPath,
    vaultPathB
  }) => {
    const statusA = await vaultStatus(page)
    const statusB = await vaultStatus(pageB)

    expect(statusA.isOpen).toBe(true)
    expect(statusB.isOpen).toBe(true)
    expect(statusA.path).toBe(testVaultPath)
    expect(statusB.path).toBe(vaultPathB)
    expect(statusA.path).not.toBe(statusB.path)
  })
})
