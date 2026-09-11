import type { UpdaterErrorPhase } from './updater'

export type UpdaterBackendKind = 'electron-updater' | 'velopack'

/** What the install marker records at hand-off time so the next launch knows which installer was supposed to run. */
export type UpdateInstaller = UpdaterBackendKind | 'velopack-handoff'

/**
 * Backend-neutral description of a release a check found. `version` is raw
 * (Velopack packVersion / electron-updater info.version); the host formats it
 * for display.
 */
export interface AvailableUpdate {
  version: string
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  releaseNotesHtml: string | null
}

/** The one door a backend has into the shared state machine. Implemented in updater.ts. */
export interface UpdaterHost {
  onChecking(): void
  /**
   * Returns false when the version is skipped by the user (state already moved to
   * up-to-date); the backend must not download it.
   */
  onUpdateAvailable(update: AvailableUpdate): boolean
  onUpToDate(): void
  onDownloadProgress(percent: number): void
  onDownloaded(update: AvailableUpdate): void
  onError(error: unknown): void
  currentPhase(): UpdaterErrorPhase
  isAutoDownloadEnabled(): boolean
}

export interface UpdaterBackend {
  readonly kind: UpdaterBackendKind
  /**
   * Drives onChecking → onUpdateAvailable/onUpToDate. On failure the host must have
   * been told (through host.onError, or through the backend's own event stream if it
   * has one), and the rejection is rethrown so checkForUpdates() still rejects to its
   * IPC caller.
   */
  check(): Promise<void>
  /** Drives onDownloadProgress → onDownloaded. Same failure contract as check(). */
  download(): Promise<void>
  setAutoDownload(enabled: boolean): void
  /**
   * electron-updater's autoInstallOnAppQuit equivalent: whether a downloaded update
   * applies silently on a normal quit. The session-end guard turns it off.
   */
  setInstallOnQuit(enabled: boolean): void
  /**
   * A normal quit is in progress with an update downloaded; apply it without
   * relaunching if install-on-quit is on. The electron-updater backend is a no-op,
   * because electron-updater installs from its own `quit` hook.
   */
  applyOnQuit(): void
  /**
   * Explicit Restart-to-install, called from performQuitAndInstall after the marker is
   * written and after graceful shutdown. Must hand off to the installer and quit the app.
   */
  applyAndRestart(): void
}
