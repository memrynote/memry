import { describe, it, expect } from 'vitest'

import { vaultRoutes } from './vault'

describe('vaultRoutes', () => {
  it('vault_get_all returns GetVaultsResponse with at least one vault', async () => {
    const result = (await vaultRoutes.vault_get_all!(undefined)) as {
      vaults: Array<{ path: string; name: string }>
      currentVault: string | null
    }
    expect(result.vaults.length).toBeGreaterThanOrEqual(1)
    expect(result.currentVault).toBeTruthy()
  })

  it('vault_get_status reports an open vault', async () => {
    const status = (await vaultRoutes.vault_get_status!(undefined)) as {
      isOpen: boolean
      path: string | null
    }
    expect(status.isOpen).toBe(true)
    expect(status.path).toBeTruthy()
  })

  it('vault_get_config returns VaultConfig with expected fields', async () => {
    const config = (await vaultRoutes.vault_get_config!(undefined)) as {
      excludePatterns: string[]
      defaultNoteFolder: string
      journalFolder: string
      attachmentsFolder: string
    }
    expect(Array.isArray(config.excludePatterns)).toBe(true)
    expect(config.defaultNoteFolder).toBeDefined()
    expect(config.journalFolder).toBeDefined()
    expect(config.attachmentsFolder).toBeDefined()
  })

  it('vault_update_config merges changes', async () => {
    const updated = (await vaultRoutes.vault_update_config!({
      defaultNoteFolder: 'Custom'
    })) as { defaultNoteFolder: string }
    expect(updated.defaultNoteFolder).toBe('Custom')
  })

  it('vault_select returns SelectVaultResponse with vault', async () => {
    const result = (await vaultRoutes.vault_select!({
      path: '/mock/path/new-vault'
    })) as { success: boolean; vault: { path: string } }
    expect(result.success).toBe(true)
    expect(result.vault.path).toBe('/mock/path/new-vault')
  })

  it('vault_switch returns success', async () => {
    const result = (await vaultRoutes.vault_switch!({
      path: '/mock/path/secondary'
    })) as { success: boolean }
    expect(result.success).toBe(true)
  })

  it('vault_close returns success', async () => {
    const result = (await vaultRoutes.vault_close!(undefined)) as { success: boolean }
    expect(result.success).toBe(true)
  })

  it('vault_reveal returns success', async () => {
    const result = (await vaultRoutes.vault_reveal!(undefined)) as { success: boolean }
    expect(result.success).toBe(true)
  })

  it('vault_reindex returns filesIndexed count', async () => {
    const result = (await vaultRoutes.vault_reindex!(undefined)) as {
      success: boolean
      filesIndexed: number
    }
    expect(result.success).toBe(true)
    expect(typeof result.filesIndexed).toBe('number')
  })
})
