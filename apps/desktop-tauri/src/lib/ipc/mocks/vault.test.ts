import { describe, it, expect } from 'vitest'

import { vaultRoutes } from './vault'

describe('vaultRoutes', () => {
  it('vault_get_all returns at least one fixture vault', async () => {
    const list = (await vaultRoutes.vault_get_all!(undefined)) as Array<{ id: string }>
    expect(list.length).toBeGreaterThanOrEqual(1)
  })

  it('vault_get_status reports an open vault', async () => {
    const status = (await vaultRoutes.vault_get_status!(undefined)) as {
      state: string
      path: string | null
    }
    expect(status.state).toBe('open')
    expect(status.path).toBeTruthy()
  })

  it('vault_get_config returns the active vault config', async () => {
    const config = (await vaultRoutes.vault_get_config!(undefined)) as {
      name: string
      path: string
    }
    expect(config.name).toBeDefined()
    expect(config.path).toBeDefined()
  })

  it('vault_update_config merges changes', async () => {
    const updated = (await vaultRoutes.vault_update_config!({ name: 'Renamed vault' })) as {
      name: string
    }
    expect(updated.name).toBe('Renamed vault')
  })

  it('vault_select returns the selected vault metadata', async () => {
    const selected = (await vaultRoutes.vault_select!({
      path: '/mock/path/new-vault'
    })) as { path: string }
    expect(selected.path).toBe('/mock/path/new-vault')
  })

  it('vault_switch flips the active vault', async () => {
    const result = (await vaultRoutes.vault_switch!({
      path: '/mock/path/secondary'
    })) as { ok: boolean; active: string }
    expect(result.ok).toBe(true)
    expect(result.active).toBe('/mock/path/secondary')
  })

  it('vault_close sets state to closed', async () => {
    const result = (await vaultRoutes.vault_close!(undefined)) as { state: string }
    expect(result.state).toBe('closed')
  })

  it('vault_reveal returns ok', async () => {
    const result = (await vaultRoutes.vault_reveal!(undefined)) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('vault_reindex returns filesIndexed count', async () => {
    const result = (await vaultRoutes.vault_reindex!(undefined)) as {
      ok: boolean
      filesIndexed: number
    }
    expect(result.ok).toBe(true)
    expect(typeof result.filesIndexed).toBe('number')
  })
})
