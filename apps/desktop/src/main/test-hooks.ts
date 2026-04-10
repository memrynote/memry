import { store } from './store'
import { persistKeysAndRegisterDevice } from './ipc/sync-handlers'

export interface SyncTestBootstrapInput {
  email: string
  setupToken: string
  masterKeyBase64: string
  signingSecretKeyBase64: string
  kdfSalt: string
  keyVerifier: string
  skipSetup?: boolean
}

interface MemryTestHooks {
  bootstrapSyncDevice(input: SyncTestBootstrapInput): Promise<{ deviceId: string }>
}

declare global {
  var __memryTestHooks: MemryTestHooks | undefined
}

export function registerTestHooks(): void {
  if (process.env.NODE_ENV !== 'test') {
    return
  }

  globalThis.__memryTestHooks = {
    async bootstrapSyncDevice(input: SyncTestBootstrapInput): Promise<{ deviceId: string }> {
      const deviceId = await persistKeysAndRegisterDevice(
        Buffer.from(input.masterKeyBase64, 'base64'),
        Buffer.from(input.signingSecretKeyBase64, 'base64'),
        input.setupToken,
        input.kdfSalt,
        input.keyVerifier,
        input.skipSetup ?? false
      )

      store.set('sync', {
        ...store.get('sync'),
        email: input.email,
        recoveryPhraseConfirmed: true
      })

      return { deviceId }
    }
  }
}
