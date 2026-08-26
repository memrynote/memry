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
 * A miss refetches, but no more often than the cooldown: a device the user
 * adds later must not stay unknown for the rest of the process (its
 * attachments would sit `pending` forever), while a genuinely unknown signer
 * must not turn every chunk request into an `/auth/devices` call.
 */

/** Shortest gap between two refetches provoked by a cache miss. */
const MISS_REFETCH_COOLDOWN_MS = 60_000

export class DeviceKeyDirectory {
  private keys = new Map<string, Uint8Array>()
  private lastFetchAt = 0
  private inFlight: Promise<void> | null = null

  constructor(private readonly httpCtx: () => SeamHttpContext) {}

  async resolve(deviceId: string): Promise<Uint8Array | null> {
    const cached = this.keys.get(deviceId)
    if (cached) return cached
    if (Date.now() - this.lastFetchAt >= MISS_REFETCH_COOLDOWN_MS) await this.refresh()
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
      this.lastFetchAt = Date.now()
    } catch (err) {
      // The timestamp is NOT advanced, so the next resolve retries straight
      // away: a transient failure here must not mark every signer unknown for
      // a whole cooldown.
      log.warn('Device key fetch failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
