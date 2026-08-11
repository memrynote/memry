import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
      return true
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }
  }

  const emitter = new MockEmitter()
  const storeState: {
    prefs: { skippedVersion?: string; autoDownload?: boolean; autoCheck?: boolean }
  } = { prefs: {} }
  return {
    storeState,
    store: {
      getUpdaterPrefs: vi.fn(() => storeState.prefs),
      setSkippedVersion: vi.fn((version: string | null) => {
        storeState.prefs = { ...storeState.prefs, skippedVersion: version ?? undefined }
      }),
      setAutoDownloadPref: vi.fn((enabled: boolean) => {
        storeState.prefs = { ...storeState.prefs, autoDownload: enabled }
      }),
      setAutoCheckPref: vi.fn((enabled: boolean) => {
        storeState.prefs = { ...storeState.prefs, autoCheck: enabled }
      })
    },
    app: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.2.3'),
      quit: vi.fn()
    },
    windows: [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn()
        }
      }
    ],
    dialog: {
      showMessageBox: vi.fn()
    },
    // Stable across createLogger() calls so tests can assert on the enriched
    // updater-failure payloads (issue #842).
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    autoUpdater: Object.assign(emitter, {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn()
    })
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: {
    getAllWindows: () => mocks.windows
  },
  dialog: mocks.dialog
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater
}))

vi.mock('./store', () => ({
  getUpdaterPrefs: mocks.store.getUpdaterPrefs,
  setSkippedVersion: mocks.store.setSkippedVersion,
  setAutoDownloadPref: mocks.store.setAutoDownloadPref,
  setAutoCheckPref: mocks.store.setAutoCheckPref
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('./lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`,
    getFixedT:
      () =>
      (key: string, values?: Record<string, unknown>): string =>
        `${key}${values ? JSON.stringify(values) : ''}`
  })
}))

vi.mock('./lib/app-version-display', () => ({
  formatAppVersionForDisplay: (version: string) => `v${version}`
}))

// The real modules pull the telemetry runtime, whose electron import ('net')
// the mock above does not provide.
vi.mock('./telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))
vi.mock('./telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))
vi.mock('./telemetry/update-install-marker', () => ({
  markUpdateInstallStarted: vi.fn()
}))

import { markUpdateInstallStarted } from './telemetry/update-install-marker'

async function loadUpdater() {
  vi.resetModules()
  return import('./updater')
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.prefs = {}
    mocks.autoUpdater.removeAllListeners()
    mocks.autoUpdater.autoDownload = true
    mocks.autoUpdater.autoInstallOnAppQuit = false
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined)
    mocks.autoUpdater.downloadUpdate.mockResolvedValue(undefined)
    mocks.autoUpdater.quitAndInstall.mockImplementation(() => undefined)
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('1.2.3')
    mocks.app.quit.mockClear()
    mocks.windows[0].webContents.send.mockClear()
  })

  it('keeps updater unavailable outside packaged builds', async () => {
    mocks.app.isPackaged = false
    const updater = await loadUpdater()

    updater.initializeUpdater()

    expect(updater.getUpdateState()).toMatchObject({
      currentVersion: 'v1.2.3',
      status: 'unavailable',
      updateSupported: false
    })
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ status: 'unavailable' })
    await expect(updater.downloadUpdate()).resolves.toMatchObject({ status: 'unavailable' })
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('initializes packaged updater and broadcasts state changes from updater events', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('checking-for-update')
    expect(updater.getUpdateState()).toMatchObject({
      status: 'checking',
      error: null,
      downloadProgressPercent: null
    })

    mocks.autoUpdater.emit('update-not-available')
    expect(updater.getUpdateState()).toMatchObject({
      status: 'up-to-date',
      availableVersion: null
    })

    mocks.autoUpdater.emit('download-progress', { percent: 120.4 })
    expect(updater.getUpdateState()).toMatchObject({
      status: 'downloading',
      downloadProgressPercent: 100
    })

    mocks.autoUpdater.emit('error', new Error('network failed'))
    expect(updater.getUpdateState()).toMatchObject({
      status: 'error',
      error: 'network failed'
    })
    expect(mocks.windows[0].webContents.send).toHaveBeenCalled()
    expect(mocks.autoUpdater.autoDownload).toBe(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('exposes available-update state without a native prompt or auto-download', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseName: 'MemryNote 1.2.4',
      releaseDate: '2026-05-10',
      releaseNotes: [{ version: '1.2.4', note: 'Desktop sync fixes' }, { note: 'Calendar fixes' }]
    })
    await flushAsyncWork()

    // The in-app modal renders from this state — no native OS dialog, and the
    // download waits for the user (auto-download off by default).
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.getUpdateState()).toMatchObject({
      status: 'available',
      availableVersion: 'v1.2.4',
      releaseName: 'MemryNote 1.2.4',
      releaseDate: '2026-05-10',
      autoDownloadEnabled: false,
      error: null
    })
    expect(updater.getUpdateState().releaseNotes).toContain('Desktop sync fixes')
  })

  it('strips HTML from release notes exposed in the update state', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.6',
      releaseNotes: '<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>'
    })
    await flushAsyncWork()

    const { releaseNotes } = updater.getUpdateState()
    expect(releaseNotes).toContain('Sync fix')
    expect(releaseNotes).toContain('• Calendar fix')
    expect(releaseNotes).not.toMatch(/<[^>]+>/)
    expect(releaseNotes).toBe('Fixes\n• Sync fix\n• Calendar fix')
  })

  it('strips the developer changelog from string release notes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes:
        '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>Full Changelog: https://x</p><p>#123 title @a</p>'
    })
    expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
  })

  it('strips the developer changelog from array release notes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes: [
        { note: '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>#1 x</p>' }
      ]
    })
    expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
  })

  it('leaves curated-only notes untouched', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes: '<h2>New Features</h2><ul><li>Calendar sync</li></ul>'
    })
    expect(updater.getUpdateState().releaseNotes).toBe('New Features\n• Calendar sync')
  })

  it('keeps the full release-notes html (changelog + PR links) for the release-notes tab', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    const html =
      '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2>' +
      '<p>Full Changelog: https://x</p>' +
      '<p><a href="https://github.com/memrynote/memry/pull/123">#123</a> title @a</p>'
    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: html })
    await flushAsyncWork()

    const state = updater.getUpdateState()
    // The modal text stays stripped to the curated bullets…
    expect(state.releaseNotes).toBe('Fixes\n• Sync fix')
    // …but the release-notes tab keeps the entire body, including the clickable PR link.
    expect(state.releaseNotesHtml).toBe(html)
    expect(state.releaseNotesHtml).toContain('pull/123')
  })

  it('combines array release notes into html for the tab', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes: [
        { version: '1.2.4', note: '<ul><li>A</li></ul>' },
        { note: '<ul><li>B</li></ul>' }
      ]
    })
    await flushAsyncWork()

    const html = updater.getUpdateState().releaseNotesHtml
    expect(html).toContain('<li>A</li>')
    expect(html).toContain('<li>B</li>')
    expect(html).toContain('v1.2.4')
  })

  it('clears release-notes html when no update is available or the version is skipped', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: '<p>notes</p>' })
    expect(updater.getUpdateState().releaseNotesHtml).toBe('<p>notes</p>')

    updater.skipVersion('v1.2.4')
    expect(updater.getUpdateState().releaseNotesHtml).toBeNull()

    mocks.autoUpdater.emit('update-not-available')
    expect(updater.getUpdateState().releaseNotesHtml).toBeNull()
  })

  it('starts the download immediately when auto-download is enabled while an update already waits', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: 'notes' })
    expect(updater.getUpdateState().status).toBe('available')
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    updater.setAutoDownloadEnabled(true)
    await flushAsyncWork()
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not start a download when auto-download is enabled with no update available', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    updater.setAutoDownloadEnabled(true)
    await flushAsyncWork()
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('skips a version: clears the current prompt and suppresses it on re-check', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: 'notes' })
    expect(updater.getUpdateState().status).toBe('available')

    const next = updater.skipVersion('v1.2.4')
    expect(mocks.store.setSkippedVersion).toHaveBeenCalledWith('v1.2.4')
    expect(next.status).toBe('up-to-date')
    expect(next.availableVersion).toBeNull()

    // The same version re-emitted stays suppressed (no 'available').
    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: 'notes' })
    expect(updater.getUpdateState().status).toBe('up-to-date')

    // A different version still surfaces.
    mocks.autoUpdater.emit('update-available', { version: '1.2.5', releaseNotes: 'notes' })
    expect(updater.getUpdateState()).toMatchObject({
      status: 'available',
      availableVersion: 'v1.2.5'
    })
  })

  it('clears a skipped version on a manual (clearSkip) check', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    updater.skipVersion('v1.2.4')

    await updater.checkForUpdates({ clearSkip: true })
    expect(mocks.store.setSkippedVersion).toHaveBeenCalledWith(null)
  })

  it('persists and applies the auto-download preference', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    const next = updater.setAutoDownloadEnabled(true)
    expect(mocks.store.setAutoDownloadPref).toHaveBeenCalledWith(true)
    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(next.autoDownloadEnabled).toBe(true)
  })

  it('honors a persisted auto-download preference at startup', async () => {
    mocks.storeState.prefs = { autoDownload: true }
    const updater = await loadUpdater()
    updater.initializeUpdater()

    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(updater.getUpdateState().autoDownloadEnabled).toBe(true)
  })

  it('auto-checks at startup and re-checks on a short (~10 min) interval by default', async () => {
    vi.useFakeTimers()
    try {
      const updater = await loadUpdater()
      updater.initializeUpdater()

      expect(updater.getUpdateState().autoCheckEnabled).toBe(true)
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

      // A short interval keeps freshly published releases picked up quickly while
      // the app is open (previously 6h — too slow to surface an update in-session).
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the startup auto-check when the preference is disabled', async () => {
    mocks.storeState.prefs = { autoCheck: false }
    const updater = await loadUpdater()
    updater.initializeUpdater()

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getUpdateState().autoCheckEnabled).toBe(false)
  })

  it('persists the auto-check preference and fires an immediate check when enabled', async () => {
    mocks.storeState.prefs = { autoCheck: false }
    const updater = await loadUpdater()
    updater.initializeUpdater()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    const next = updater.setAutoCheckEnabled(true)
    expect(mocks.store.setAutoCheckPref).toHaveBeenCalledWith(true)
    expect(next.autoCheckEnabled).toBe(true)
    // Enabling triggers a check right away so the user gets instant feedback.
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.setAutoCheckEnabled(false)
    expect(mocks.store.setAutoCheckPref).toHaveBeenCalledWith(false)
    expect(updater.getUpdateState().autoCheckEnabled).toBe(false)
  })

  it('coalesces manual checks and downloads, then installs downloaded updates', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    const firstCheck = updater.checkForUpdates()
    const secondCheck = updater.checkForUpdates()
    await Promise.all([firstCheck, secondCheck])
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    const firstDownload = updater.downloadUpdate()
    const secondDownload = updater.downloadUpdate()
    await Promise.all([firstDownload, secondDownload])
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    expect(() => updater.quitAndInstall()).toThrow('No downloaded update is ready to install')

    mocks.autoUpdater.emit('update-downloaded', {
      version: '1.2.5',
      releaseNotes: 'Ready to install'
    })
    await flushAsyncWork()
    updater.quitAndInstall()
    await flushAsyncWork()

    expect(updater.getUpdateState()).toMatchObject({
      // Clicking Restart flips the UI to the "installing" screen immediately.
      status: 'installing',
      availableVersion: 'v1.2.5',
      releaseNotes: 'Ready to install',
      downloadProgressPercent: 100
    })
    // quitAndInstall triggers a graceful app quit (so before-quit cleanup runs)
    // instead of installing immediately; the install runs after cleanup.
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(updater.isQuitAndInstallRequested()).toBe(true)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  // Issue #842: prod updater failures shipped as `{"errorName":"Error"}` and nothing
  // else, because the log-ship transport keeps only the first string argument as the
  // message and drops the Error's own message. Every updater failure now carries an
  // explicit fields object so the payload is diagnosable in Loki.
  describe('error payload enrichment (#842)', () => {
    it('extracts message, code, http status and url from an electron-updater error', async () => {
      const updater = await loadUpdater()
      const error = Object.assign(
        new Error('Cannot download "https://x.test/latest.yml", status 404'),
        {
          name: 'HttpError',
          code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
          statusCode: 404,
          url: 'https://x.test/latest.yml'
        }
      )

      expect(updater.describeUpdaterError(error, 'download')).toMatchObject({
        phase: 'download',
        errorName: 'HttpError',
        errorMessage: 'Cannot download "https://x.test/latest.yml", status 404',
        errorCode: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
        httpStatus: 404,
        url: 'https://x.test/latest.yml'
      })
      expect(updater.describeUpdaterError(error, 'download').errorStack).toContain(
        'updater.test.ts'
      )
    })

    it('keeps a non-Error rejection diagnosable', async () => {
      const updater = await loadUpdater()

      expect(updater.describeUpdaterError('boom', 'startup-check')).toEqual({
        phase: 'startup-check',
        errorName: 'NonError',
        errorMessage: 'boom'
      })
    })

    it('reports the errno and cause of a network failure', async () => {
      const updater = await loadUpdater()
      const error = Object.assign(new Error('request failed'), {
        code: 'ENOTFOUND',
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
      })

      expect(updater.describeUpdaterError(error, 'scheduled-check')).toMatchObject({
        phase: 'scheduled-check',
        errorCode: 'ENOTFOUND',
        errorCause: 'Error: getaddrinfo ENOTFOUND github.com (ENOTFOUND)'
      })
    })

    it('logs the updater error event with the phase inferred from the current status', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()

      mocks.autoUpdater.emit('checking-for-update')
      const checkError = Object.assign(new Error('network failed'), { code: 'ECONNRESET' })
      mocks.autoUpdater.emit('error', checkError)

      expect(mocks.logger.error).toHaveBeenCalledWith(
        'updater error',
        checkError,
        expect.objectContaining({
          phase: 'check',
          errorName: 'Error',
          errorMessage: 'network failed',
          errorCode: 'ECONNRESET'
        })
      )
    })

    it('logs a download-phase updater error while a download is in flight', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()

      void updater.downloadUpdate()
      mocks.autoUpdater.emit('error', new Error('disk full'))

      expect(mocks.logger.error).toHaveBeenCalledWith(
        'updater error',
        expect.any(Error),
        expect.objectContaining({ phase: 'download', errorMessage: 'disk full' })
      )
    })

    it('enriches startup and scheduled check failures', async () => {
      vi.useFakeTimers()
      try {
        mocks.autoUpdater.checkForUpdates.mockRejectedValue(
          Object.assign(new Error('feed unreachable'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })
        )
        const updater = await loadUpdater()
        updater.initializeUpdater()
        await vi.advanceTimersByTimeAsync(0)

        expect(mocks.logger.warn).toHaveBeenCalledWith(
          'startup update check failed',
          expect.any(Error),
          expect.objectContaining({
            phase: 'startup-check',
            errorMessage: 'feed unreachable',
            errorCode: 'ERR_UPDATER_INVALID_RELEASE_FEED'
          })
        )

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          'scheduled update check failed',
          expect.any(Error),
          expect.objectContaining({ phase: 'scheduled-check', errorMessage: 'feed unreachable' })
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('installs the downloaded update only after graceful shutdown completes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    mocks.autoUpdater.emit('update-downloaded', {
      version: '1.2.7',
      releaseNotes: 'Ready'
    })
    await flushAsyncWork()

    expect(updater.isQuitAndInstallRequested()).toBe(false)

    // User clicks "Restart now": request a graceful quit, do not install yet.
    updater.quitAndInstall()
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(updater.isQuitAndInstallRequested()).toBe(true)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // The shutdown handler calls performQuitAndInstall() after cleanup; only
    // then does Squirrel install + relaunch.
    updater.performQuitAndInstall()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    // Silent install (/S) + relaunch (--force-run) on Windows NSIS.
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('records the install attempt before handing off, so a failed install is detectable', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    mocks.autoUpdater.emit('update-downloaded', { version: '1.2.7' })
    await flushAsyncWork()
    updater.quitAndInstall()

    updater.performQuitAndInstall()

    // Raw app version (comparable on the next launch) + the display version of
    // the build being installed.
    expect(markUpdateInstallStarted).toHaveBeenCalledWith('1.2.3', 'v1.2.7')
    // The marker must land BEFORE the handoff: afterwards the process is gone.
    expect(vi.mocked(markUpdateInstallStarted).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.autoUpdater.quitAndInstall.mock.invocationCallOrder[0]
    )
  })

  it("surfaces a previous session's failed install in the state the renderer reads", async () => {
    const updater = await loadUpdater()

    // Called at startup from the update-install marker, BEFORE initializeUpdater.
    updater.noteFailedUpdateInstall('v1.2.7')
    updater.initializeUpdater()

    // Must survive updater init: otherwise the user gets the same prompt, the
    // same Restart, and never learns the install is what is failing.
    expect(updater.getUpdateState().installFailed).toEqual({ version: 'v1.2.7' })
  })

  it('records a failed install whose target version the marker never captured', async () => {
    const updater = await loadUpdater()

    updater.noteFailedUpdateInstall(null)

    // Still worth surfacing: the failure is what matters, not which version.
    expect(updater.getUpdateState().installFailed).toEqual({ version: null })
  })

  it("routes electron-updater's own diagnostics into the app log instead of a dead console", async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    // Without this the installer-spawn failures electron-updater logs itself
    // ("Cannot run installer: error code: ...") never reach main.log.
    expect(mocks.autoUpdater.logger).toBeDefined()
    mocks.autoUpdater.logger.info('Cannot run installer: error code: EACCES')
    expect(mocks.logger.info).toHaveBeenCalledWith('Cannot run installer: error code: EACCES')
  })
})
