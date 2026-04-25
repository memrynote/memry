import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import type { MockRouteMap } from './types'

const CURRENT_VERSION = '2.0.0-alpha.1'

const baseState: AppUpdateState = {
  currentVersion: CURRENT_VERSION,
  status: 'unavailable',
  updateSupported: false,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null
}

let state: AppUpdateState = { ...baseState }

function snapshot(): AppUpdateState {
  return { ...state }
}

/**
 * Mock surface for the auto-updater. The real Tauri command shim lands in M9
 * (auto-update milestone); until then `useAppUpdater` calls these mocked
 * routes and observes that updates are not supported. The shape MUST match
 * `AppUpdateState` from `@memry/contracts/ipc-updater` so future renderer
 * tightening (e.g. discriminated union changes) breaks tests instead of
 * silently disagreeing with the hook.
 */
export const updaterRoutes: MockRouteMap = {
  updater_get_state: async () => snapshot(),
  updater_check_for_updates: async () => {
    state = { ...state, status: 'up-to-date', lastCheckedAt: Date.now(), error: null }
    return snapshot()
  },
  updater_download_update: async () => {
    // Updater-not-supported in M2; returning the same state keeps the renderer
    // banner inert without surfacing an error.
    return snapshot()
  },
  updater_quit_and_install: async () => undefined
}
