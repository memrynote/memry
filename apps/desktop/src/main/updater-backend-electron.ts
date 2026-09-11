import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { createLogger } from './lib/logger'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { htmlToPlainText } from './lib/html-to-plain-text'
import { isExpiredSignedAssetError, isUpdaterCheckPhase } from './updater-error-severity'
import { describeUpdaterError } from './updater'
import { plainTextReleaseNotes, stripDeveloperChangelog } from './updater-release-notes'
import type { AvailableUpdate, UpdaterBackend, UpdaterHost } from './updater-backend'

/**
 * electron-updater defaults its own logger to `console` (AppUpdater sets it at
 * construction), and a packaged build has no console attached — so its
 * diagnostics went nowhere. That is the half of the update pipeline we never
 * see: "Cannot run installer: error code: EACCES/UNKNOWN/ENOENT", the
 * elevate.exe retry, differential-download fallbacks. Routing them into the app
 * log makes a user's main.log answer why an update did not install.
 */
const libraryLogger = createLogger('ElectronUpdater')
const updaterLibraryLogger = {
  info: (message?: unknown) => logMessage('info', message),
  warn: (message?: unknown) => logMessage('warn', message),
  error: (message?: unknown) => logMessage('error', message),
  debug: (message?: unknown) => logMessage('debug', message)
}

function logMessage(level: 'info' | 'warn' | 'error' | 'debug', message?: unknown): void {
  // electron-updater passes arbitrary values here; best-effort stringify for the log line.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  libraryLogger[level](typeof message === 'string' ? message : String(message ?? ''))
}

/**
 * Extra attempts for a check that died on an expired GitHub signed-asset URL,
 * and the pause before each. A check is three small GETs, so asking again is
 * cheap; the delay is there because the expiry is a timing race, not a state we
 * can observe. Bounded at two so a genuinely refused asset still fails within
 * seconds instead of retrying forever.
 */
const SIGNED_ASSET_RETRY_ATTEMPTS = 2
const SIGNED_ASSET_RETRY_DELAY_MS = 2_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const logger = createLogger('Updater')

export function createElectronUpdaterBackend(host: UpdaterHost): UpdaterBackend {
  /**
   * Retries still available for the in-flight check. electron-updater emits its
   * `error` event *before* checkForUpdates() rejects, so without this the first
   * attempt would already have flipped the UI to `error` and shipped an exception
   * for a failure we are about to recover from. Zero whenever no check is running,
   * so a download- or install-phase failure is never suppressed.
   */
  let signedAssetRetriesLeft = 0

  autoUpdater.logger = updaterLibraryLogger
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    host.onChecking()
  })

  autoUpdater.on('update-available', (info) => {
    // When auto-download is on, electron-updater downloads automatically (autoDownload=true),
    // so the state flows straight to 'downloading' without prompting. The skip decision
    // the host returns only suppresses the prompt, as it always has.
    host.onUpdateAvailable(toAvailableUpdate(info))
  })

  autoUpdater.on('update-not-available', () => {
    host.onUpToDate()
  })

  autoUpdater.on('download-progress', (progress) => {
    host.onDownloadProgress(progress.percent)
  })

  autoUpdater.on('update-downloaded', (info) => {
    host.onDownloaded(toAvailableUpdate(info))
  })

  autoUpdater.on('error', (error) => {
    const phase = host.currentPhase()
    // An expired signed release-asset URL is a token that aged out mid-redirect,
    // not a broken update. check() is about to ask GitHub again for a fresh one,
    // so leave the user-facing state and the telemetry alone — surfacing a
    // failure we then recover from is the noise, not the signal.
    if (
      signedAssetRetriesLeft > 0 &&
      isUpdaterCheckPhase(phase) &&
      isExpiredSignedAssetError(error)
    ) {
      logger.warn(
        'update check hit an expired release-asset url, retrying',
        error,
        describeUpdaterError(error, phase)
      )
      return
    }
    host.onError(error)
  })

  return {
    kind: 'electron-updater',
    /**
     * Ask again when GitHub's signed release-asset URL expired between the redirect
     * and the follow-up GET (status 618, `jwt:expired`). electron-updater does not
     * retry that itself, so a single aged-out token used to lose the whole check —
     * 36 production exceptions across four releases, all in the check phase. Only
     * the final attempt reaches the `error` handler, which is the one that reports
     * to the host; the rejection is rethrown without a second report.
     */
    async check(): Promise<void> {
      try {
        for (let attempt = 0; ; attempt += 1) {
          signedAssetRetriesLeft = SIGNED_ASSET_RETRY_ATTEMPTS - attempt
          try {
            await autoUpdater.checkForUpdates()
            return
          } catch (error) {
            if (signedAssetRetriesLeft <= 0 || !isExpiredSignedAssetError(error)) {
              throw error
            }
            await delay(SIGNED_ASSET_RETRY_DELAY_MS * (attempt + 1))
          }
        }
      } finally {
        signedAssetRetriesLeft = 0
      }
    },
    async download(): Promise<void> {
      // No host.onError here either: a failed download raises the `error` event above.
      await autoUpdater.downloadUpdate()
    },
    setAutoDownload(enabled: boolean): void {
      // electron-updater reads autoDownload only when the NEXT update-available fires.
      autoUpdater.autoDownload = enabled
    },
    setInstallOnQuit(enabled: boolean): void {
      autoUpdater.autoInstallOnAppQuit = enabled
    },
    applyOnQuit(): void {
      // electron-updater installs from its own `quit` hook when autoInstallOnAppQuit is on.
    },
    // (isSilent=true, isForceRunAfter=true): install with no visible NSIS window
    // (adds /S) and relaunch afterwards (adds --force-run). macOS Squirrel relaunches
    // regardless; the flags only affect the Windows NSIS installer.
    applyAndRestart(): void {
      autoUpdater.quitAndInstall(true, true)
    }
  }
}

function toAvailableUpdate(info: UpdateInfo): AvailableUpdate {
  return {
    version: info.version,
    releaseName: info.releaseName ?? null,
    releaseDate: info.releaseDate ?? null,
    releaseNotes: normalizeReleaseNotes(info),
    releaseNotesHtml: rawReleaseNotesHtml(info)
  }
}

/**
 * The full release-notes body kept verbatim (HTML from the update feed) for the
 * read-only "release notes" tab. Unlike normalizeReleaseNotes, this does NOT convert
 * to plain text or strip the developer changelog, so the tab keeps the clickable PR
 * references / Full Changelog link. For array feeds each entry is prefixed with its
 * version heading.
 */
function rawReleaseNotesHtml(info: UpdateInfo): string | null {
  const { releaseNotes } = info

  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null
  }

  const combined = releaseNotes
    .map((entry) => {
      const heading = entry.version ? `<h3>${formatAppVersionForDisplay(entry.version)}</h3>\n` : ''
      return `${heading}${entry.note ?? ''}`.trim()
    })
    .filter(Boolean)
    .join('\n')

  return combined || null
}

function normalizeReleaseNotes(info: UpdateInfo): string | null {
  const { releaseNotes } = info

  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === 'string') {
    return plainTextReleaseNotes(releaseNotes)
  }

  const combined = releaseNotes
    .map((entry) => {
      const heading = entry.version ? `${formatAppVersionForDisplay(entry.version)}\n` : ''
      return `${heading}${stripDeveloperChangelog(htmlToPlainText(entry.note ?? ''))}`.trim()
    })
    .filter(Boolean)
    .join('\n\n')

  return combined || null
}
