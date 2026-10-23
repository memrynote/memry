import { app } from 'electron'
import type { UpdateInfo, UpdateManager } from 'velopack'
import { createLogger } from './lib/logger'
import { describeUpdaterError } from './updater'
import { plainTextReleaseNotes } from './updater-release-notes'
import { loadVelopack } from './velopack-native'
import type { AvailableUpdate, UpdaterBackend, UpdaterHost } from './updater-backend'

/**
 * Velopack reads the GitHub releases feed directly (assets + release notes), so the
 * feed is the repository itself — no generated latest.yml, unlike electron-updater.
 */
export const VELOPACK_FEED_URL = 'https://github.com/memrynote/memry'

const logger = createLogger('VelopackUpdater')

/**
 * Returns null when this process is not a Velopack install — an NSIS install, a
 * portable copy, a dev run. Velopack's UpdateManager constructor is the only way to
 * ask: it throws "This application is not properly installed" rather than exposing a
 * predicate. The caller falls back to electron-updater.
 */
export function createVelopackBackend(host: UpdaterHost): UpdaterBackend | null {
  let manager: UpdateManager
  try {
    manager = new (loadVelopack().UpdateManager)(VELOPACK_FEED_URL)
  } catch (error) {
    logger.info('not a Velopack install; falling back to electron-updater', {
      reason: error instanceof Error ? error.message : String(error)
    })
    return null
  }

  let pending: UpdateInfo | null = null
  let downloaded = false
  let handedOff = false
  let installOnQuit = true
  /**
   * Velopack has no internal download dedupe (a second downloadUpdateAsync fails on
   * its global update lock), and the auto-download below bypasses the host's own
   * coalescing — so the user pressing Download while the automatic one is in flight
   * has to land on the same promise.
   */
  let inFlightDownload: Promise<void> | null = null

  async function runDownload(): Promise<void> {
    const info = pending
    if (!info) {
      const error = new Error('No update available to download')
      host.onError(error)
      throw error
    }

    try {
      await manager.downloadUpdateAsync(info, (percent) => host.onDownloadProgress(percent))
    } catch (error) {
      host.onError(error)
      throw error
    }

    downloaded = true
    host.onDownloaded(toAvailableUpdate(info))
  }

  const backend: UpdaterBackend = {
    kind: 'velopack',
    installer: 'velopack',
    async check(): Promise<void> {
      host.onChecking()
      let info: UpdateInfo | null
      try {
        info = await manager.checkForUpdatesAsync()
      } catch (error) {
        host.onError(error)
        throw error
      }

      if (!info) {
        host.onUpToDate()
        return
      }

      // A repeat check that finds the same release must not un-download it: the
      // auto-check timer keeps running while an update sits in 'downloaded'.
      if (pending?.TargetFullRelease.Version !== info.TargetFullRelease.Version) {
        downloaded = false
        handedOff = false
      }
      pending = info

      if (!host.onUpdateAvailable(toAvailableUpdate(info)) || !host.isAutoDownloadEnabled()) {
        return
      }
      // Matches electron-updater's autoDownload semantics: the check resolves once the
      // download has started, and the download reports its own failure through the host.
      void backend.download().catch(() => {})
    },
    async download(): Promise<void> {
      inFlightDownload ??= runDownload().finally(() => {
        inFlightDownload = null
      })
      return inFlightDownload
    },
    setAutoDownload(): void {
      // Nothing to mirror: check() reads the preference from the host when it needs it.
    },
    setInstallOnQuit(enabled: boolean): void {
      installOnQuit = enabled
    },
    applyOnQuit(): void {
      if (!installOnQuit || !downloaded || handedOff || !pending) {
        return
      }
      try {
        manager.waitExitThenApplyUpdate(pending, true, false)
        handedOff = true
      } catch (error) {
        // The quit is already under way and the telemetry runtime is disposed, so this
        // stays a log line; the install marker reports the miss on the next launch.
        logger.warn('install-on-quit handoff failed', error, describeUpdaterError(error, 'install'))
      }
    },
    applyAndRestart(): void {
      try {
        if (!pending) {
          throw new Error('No downloaded update to apply')
        }
        manager.waitExitThenApplyUpdate(pending, true, true)
        handedOff = true
      } catch (error) {
        host.onError(error)
      } finally {
        // The user asked to quit either way. A failed hand-off is reported by the
        // install marker on the next launch.
        app.quit()
      }
    }
  }

  return backend
}

function toAvailableUpdate(info: UpdateInfo): AvailableUpdate {
  const asset = info.TargetFullRelease
  const html = asset.NotesHtml?.trim() ?? ''
  const markdown = asset.NotesMarkdown?.trim() ?? ''
  return {
    version: asset.Version,
    releaseName: null,
    releaseDate: null,
    // Velopack packages both forms; the markdown is the fallback when a release was
    // packed without the HTML transform.
    releaseNotes: html ? plainTextReleaseNotes(html) : markdown || null,
    releaseNotesHtml: html || null
  }
}
