import { getSyncEngine, getSyncWebSocket } from './runtime'

export const syncStateTestHooks = {
  async disconnectSyncSocketForTests(): Promise<void> {
    const ws = getSyncWebSocket()
    if (!ws) {
      throw new Error('Sync runtime is not initialized')
    }
    ws.disconnect()
  },

  async getSyncStateValueForTests(key: string): Promise<string | null> {
    return getSyncEngine()?.getStateValue(key) ?? null
  }
}

export type SyncStateTestHooks = typeof syncStateTestHooks
