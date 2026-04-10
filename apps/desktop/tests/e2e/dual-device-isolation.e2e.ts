import { test, expect } from './fixtures/sync-fixtures'

test.describe('Dual-device isolation', () => {
  test('launches A and B with separate vaults', async ({ pageA, pageB, vaultPathA, vaultPathB }) => {
    const statusA = await pageA.evaluate(() => window.api.vault.getStatus())
    const statusB = await pageB.evaluate(() => window.api.vault.getStatus())

    expect(statusA.isOpen).toBe(true)
    expect(statusB.isOpen).toBe(true)
    expect(statusA.path).toBe(vaultPathA)
    expect(statusB.path).toBe(vaultPathB)
    expect(statusA.path).not.toBe(statusB.path)
  })
})
