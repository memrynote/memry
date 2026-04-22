export const UpdaterChannels = {
  invoke: {
    GET_STATE: 'updater:get-state',
    CHECK_FOR_UPDATES: 'updater:check-for-updates',
    DOWNLOAD_UPDATE: 'updater:download-update',
    QUIT_AND_INSTALL: 'updater:quit-and-install'
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
}
