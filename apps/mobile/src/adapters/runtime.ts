import Constants from 'expo-constants'
import { AppState } from 'react-native'
import type { RuntimeAdapter, SyncLogger } from '@memry/sync-client/adapters'
import { createLogger } from '../lib/logger'

export interface MobileRuntimeOptions {
  log?: SyncLogger
  /**
   * Provided by src/sync/background.ts (expo-background-task registration).
   * Optional so the adapter stays constructible before that module wires in.
   */
  scheduleBackgroundSync?: (minIntervalSec: number) => void
}

/** `<semver>+<build>` — the version half of the `x-memry-client` header (contracts §1). */
export function mobileAppVersion(): string {
  const semver = Constants.expoConfig?.version ?? '0.0.0'
  const build = Constants.expoConfig?.ios?.buildNumber
  return build ? `${semver}+${build}` : semver
}

/** Seam 10 on mobile: expo-constants identity + AppState lifecycle. */
export function createMobileRuntime(options: MobileRuntimeOptions = {}): RuntimeAdapter {
  return {
    appVersion: mobileAppVersion,
    platform() {
      return 'ios'
    },
    onForeground(cb) {
      let previous = AppState.currentState
      const sub = AppState.addEventListener('change', (next) => {
        if (next === 'active' && previous !== 'active') cb()
        previous = next
      })
      return () => sub.remove()
    },
    onBackground(cb) {
      let previous = AppState.currentState
      const sub = AppState.addEventListener('change', (next) => {
        if (next === 'background' && previous !== 'background') cb()
        previous = next
      })
      return () => sub.remove()
    },
    scheduleBackgroundSync(minIntervalSec) {
      options.scheduleBackgroundSync?.(minIntervalSec)
    },
    log: options.log ?? createLogger('SyncRuntime')
  }
}
