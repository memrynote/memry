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
  /**
   * The full, unstripped release-notes body (HTML from the update feed) used by the
   * in-app read-only "release notes" tab. Unlike `releaseNotes` (plain text with the
   * developer changelog stripped for the modal), this keeps the changelog + clickable
   * PR references so the tab can link through to each PR.
   */
  releaseNotesHtml: string | null
  downloadProgressPercent: number | null
  lastCheckedAt: number | null
  error: string | null
  /** Whether updates download & install automatically without prompting (persisted). */
  autoDownloadEnabled: boolean
  /** Whether the app checks for updates automatically at launch and on an interval (persisted). */
  autoCheckEnabled: boolean
  /**
   * Set on launch when the PREVIOUS session handed off to the update installer and
   * the install never applied (see telemetry/update-install-marker), null on a
   * normal launch. `version` is the update that failed, or null when the marker
   * did not record one — the failure is still worth surfacing without it.
   * Optional so an older renderer bundle reading a newer main keeps type-checking:
   * absent and null both mean "no failed install".
   */
  installFailed?: { version: string | null } | null
}
