// The vault picker: what a user sees when the app starts without an open vault.
import { test, expect } from '../../harness/test'
import { invoke, type SelectResponse, vaultStatus } from '../../harness/vault-commands'

test.use({ extraEnv: { MEMRY_FORCE_VAULT_PICKER: '1' } })

test('MEMRY_FORCE_VAULT_PICKER shows the picker with the registered vault and opens it on a click', async ({
  page,
  testVaultPath
}) => {
  expect((await vaultStatus(page)).isOpen).toBe(false)
  await expect(page.getByText('Create new vault')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Open folder as vault')).toBeVisible()
  // Each recent vault is a button with its name and path.
  const recent = page.locator('button').filter({ hasText: testVaultPath })
  await expect(recent).toBeVisible()

  await recent.click()
  await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
})

test('"Open folder as vault" takes the folder from the dialog queue', async ({
  app,
  page,
  testVaultPath
}) => {
  const { invokeTest } = await import('../../harness/invoke-test')
  await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'OpenFolder', paths: [testVaultPath] })
  await page.getByText('Open folder as vault').click()
  await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
  const response = await invoke<SelectResponse>(page, 'vault_switch', { path: testVaultPath })
  expect(response.success).toBe(true)
})
