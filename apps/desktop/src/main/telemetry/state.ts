import type { TelemetryAuthState, TelemetrySyncState } from '@memry/contracts/telemetry-api'

import { store } from '../store'
import { getSyncEngine } from '../sync/runtime'

export const getTelemetryAuthState = (): TelemetryAuthState => {
  try {
    return store.get('sync').email ? 'signed_in' : 'anonymous'
  } catch {
    return 'anonymous'
  }
}

export const getTelemetrySyncState = (): TelemetrySyncState => {
  try {
    return getSyncEngine() ? 'enabled' : 'disabled'
  } catch {
    return 'unknown'
  }
}
