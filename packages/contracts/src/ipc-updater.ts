export const UpdaterChannels = {
  invoke: {
    GET_STATE: 'updater:get-state',
    CHECK_FOR_UPDATES: 'updater:check-for-updates',
    DOWNLOAD_UPDATE: 'updater:download-update',
    QUIT_AND_INSTALL: 'updater:quit-and-install',
    SET_AUTO_CHECK: 'updater:set-auto-check',
    CONSUME_WHATS_NEW: 'updater:consume-whats-new'
  },
  events: {
    STATE_CHANGED: 'updater:state-changed'
  }
} as const

/**
 * Release notes persisted when an update finished downloading, surfaced as the
 * read-only "what's new" tab on the FIRST launch of the installed version —
 * after the restart, never before it. Consumed (read + cleared) exactly once.
 */
export interface WhatsNewPayload {
  /** Display version the notes belong to (matches the running version at consume time). */
  version: string
  /** Release-notes body to render read-only. */
  content: string
  /** How `content` should be parsed by the note renderer. */
  contentType: 'html' | 'markdown'
}

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
