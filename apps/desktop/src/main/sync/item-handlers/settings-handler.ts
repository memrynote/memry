import { SettingsSyncPayloadSchema } from '@memry/contracts/settings-sync'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { getSettingsSyncManager } from '../settings-sync'
import { createLogger } from '../../lib/logger'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('SettingsHandler')

export const settingsHandler: SyncItemHandler<SettingsSyncPayload> = {
  type: 'settings',
  schema: SettingsSyncPayloadSchema,

  applyUpsert(
    _ctx: ApplyContext,
    _itemId: string,
    data: SettingsSyncPayload,
    _clock: VectorClock
  ): ApplyResult {
    const manager = getSettingsSyncManager()
    if (!manager) {
      log.warn('SettingsSyncManager not initialized, skipping settings apply')
      return 'skipped'
    }

    manager.mergeRemote(data)
    return 'applied'
  },

  applyDelete(_ctx: ApplyContext, _itemId: string, _clock?: VectorClock): 'applied' | 'skipped' {
    return 'skipped'
  },

  fetchLocal(_db: DrizzleDb, _itemId: string): Record<string, unknown> | undefined {
    return undefined
  },

  seedUnclocked(_db: DrizzleDb, _deviceId: string, _queue: SyncQueueManager): number {
    return 0
  }
}
