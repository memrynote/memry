export const UpdaterChannels = {
  invoke: {
    GET_STATE: 'updater:get-state',
    CHECK_FOR_UPDATES: 'updater:check-for-updates',
    DOWNLOAD_UPDATE: 'updater:download-update',
    QUIT_AND_INSTALL: 'updater:quit-and-install',
    SKIP_VERSION: 'updater:skip-version',
    SET_AUTO_DOWNLOAD: 'updater:set-auto-download',
    SET_AUTO_CHECK: 'updater:set-auto-check'
  },
  events: {
    STATE_CHANGED: 'updater:state-changed'
  }
} as const

export type UpdaterStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error'

export interface AppUpdateState {
  currentVersion: string
  status: UpdaterStatus
  updateSupported: boolean
  availableVersion: string | null
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  downloadProgressPercent: number | null
  lastCheckedAt: number | null
  error: string | null
  /** Whether updates download & install automatically without prompting (persisted). */
  autoDownloadEnabled: boolean
  /** Whether the app checks for updates automatically at launch and on an interval (persisted). */
  autoCheckEnabled: boolean
}
