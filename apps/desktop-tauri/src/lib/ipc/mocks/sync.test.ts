import { describe, it, expect } from 'vitest'

import { syncRoutes } from './sync'

describe('syncRoutes', () => {
  it('sync_status reports current state + last sync time', async () => {
    const status = (await syncRoutes.sync_status!(undefined)) as {
      state: string
      lastSyncedAt: number | null
      queueDepth: number
    }
    expect(['idle', 'syncing', 'error', 'disabled']).toContain(status.state)
    expect(typeof status.queueDepth).toBe('number')
  })

  it('sync_trigger initiates a sync and returns ok', async () => {
    const res = (await syncRoutes.sync_trigger!(undefined)) as { ok: boolean }
    expect(res.ok).toBe(true)
  })

  it('sync_stats returns counts for pushed and pulled items', async () => {
    const stats = (await syncRoutes.sync_stats!(undefined)) as {
      pushed: number
      pulled: number
      failed: number
    }
    expect(typeof stats.pushed).toBe('number')
    expect(typeof stats.pulled).toBe('number')
    expect(typeof stats.failed).toBe('number')
  })

  it('sync_identity returns device identity info', async () => {
    const id = (await syncRoutes.sync_identity!(undefined)) as {
      deviceId: string
      publicKey: string
    }
    expect(id.deviceId).toBeDefined()
  })

  it('sync_enable flips the enabled flag', async () => {
    await syncRoutes.sync_enable!({ enabled: true })
    const after = (await syncRoutes.sync_status!(undefined)) as { state: string }
    expect(after.state).not.toBe('disabled')
    await syncRoutes.sync_enable!({ enabled: false })
    const afterDisable = (await syncRoutes.sync_status!(undefined)) as { state: string }
    expect(afterDisable.state).toBe('disabled')
  })

  it('sync_pending_items returns the queued items (may be empty)', async () => {
    const pending = (await syncRoutes.sync_pending_items!(undefined)) as unknown[]
    expect(Array.isArray(pending)).toBe(true)
  })
})
