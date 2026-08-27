import NetInfo from '@react-native-community/netinfo'
import type { SyncHttpClient, SyncHttpRequest, SyncHttpResponse } from '@memry/sync-client/adapters'
import { DevOfflineError, isDevOffline, subscribeDevOffline } from '../lib/dev-network'

/**
 * Seam 1 on mobile: fetch + NetInfo (contracts/platform-adapters.md §1).
 *
 * The adapter transports; it never invents headers — the engine owns
 * `x-memry-client` and auth. Unlike desktop's hardcoded `isMetered() → false`,
 * mobile's answer is real and drives the attachments Wi-Fi-only policy.
 */
export function createMobileHttpClient(baseUrl: string): SyncHttpClient {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl

  return {
    async request(req: SyncHttpRequest): Promise<SyncHttpResponse> {
      // Dev-only, and it FAILS the request rather than faking a response: the
      // offline matrix needs the app to behave as it does in airplane mode,
      // and a synthesised 5xx would exercise a different path entirely.
      if (isDevOffline()) throw new DevOfflineError()

      const path = req.path.startsWith('/') ? req.path : `/${req.path}`
      // Copy Uint8Array bodies so SharedArrayBuffer-typed views never reach
      // BodyInit (same guard as desktop's adapter).
      const body = req.body instanceof Uint8Array ? req.body.slice() : req.body
      const response = await fetch(`${base}${path}`, {
        method: req.method,
        headers: req.headers,
        body: body as BodyInit | undefined,
        signal: req.signal
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer())
      }
    },

    onOnlineChanged(cb) {
      let last: boolean | null = null
      const emit = (online: boolean): void => {
        if (online === last) return
        last = online
        cb(online)
      }

      const unsubscribeNet = NetInfo.addEventListener((state) => {
        const real = state.isConnected === true && state.isInternetReachable !== false
        emit(real && !isDevOffline())
      })
      // The switch drives this too, not just `request`. Otherwise the engine
      // still believes it is online and the paths the matrix exists to
      // exercise — parked outbox, deferred sync, the Offline banner — never
      // run at all.
      const unsubscribeDev = subscribeDevOffline(() => {
        void NetInfo.fetch().then((state) => {
          const real = state.isConnected === true && state.isInternetReachable !== false
          emit(real && !isDevOffline())
        })
      })

      return () => {
        unsubscribeNet()
        unsubscribeDev()
      }
    },

    async isMetered() {
      const state = await NetInfo.fetch()
      if (state.details && 'isConnectionExpensive' in state.details) {
        return state.details.isConnectionExpensive === true
      }
      return state.type === 'cellular'
    }
  }
}
