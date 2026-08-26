import { DeviceKeysResponseSchema } from '@memry/contracts/sync-api'
import { seamJsonRequest, type SeamHttpContext } from '@memry/sync-client/pull'
import { fromBase64 } from '../crypto/libsodium'
import { createLogger } from '../lib/logger'

const log = createLogger('DeviceKeys')

/**
 * The account's device signing public keys, cached per process.
 *
 * Every signature check on the pull side needs one of these, and so does the
 * attachment manifest — which is why the lookup lives here rather than inside
 * the sync engine, where the attachment transfer could not reach it.
 *
 * A miss is refetched ONCE: a key that is still missing after a refresh means a
 * device the server has not told us about, and hammering `/auth/devices` per
 * chunk would turn one unknown signer into a request storm.
 */
export class DeviceKeyDirectory {
  private keys = new Map<string, Uint8Array>()
  private fetched = false
  private inFlight: Promise<void> | null = null

  constructor(private readonly httpCtx: () => SeamHttpContext) {}

  async resolve(deviceId: string): Promise<Uint8Array | null> {
    const cached = this.keys.get(deviceId)
    if (cached) return cached
    if (!this.fetched) await this.refresh()
    return this.keys.get(deviceId) ?? null
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.load().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async load(): Promise<void> {
    try {
      const raw = await seamJsonRequest<unknown>(this.httpCtx(), {
        method: 'GET',
        path: '/auth/devices'
      })
      const parsed = DeviceKeysResponseSchema.safeParse(raw)
      if (!parsed.success) return
      for (const device of parsed.data.devices) {
        this.keys.set(device.id, fromBase64(device.signingPublicKey))
      }
      this.fetched = true
    } catch (err) {
      // Left unfetched so the next resolve retries: a transient failure here
      // must not permanently mark every signer unknown.
      log.warn('Device key fetch failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
