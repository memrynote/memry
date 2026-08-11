import { useCallback, useSyncExternalStore } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { getI18n } from 'react-i18next'

const DEFAULT_STATE: AppUpdateState = {
  currentVersion: '0.0.0',
  status: 'unavailable',
  updateSupported: false,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  releaseNotesHtml: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoDownloadEnabled: false,
  autoCheckEnabled: true
}

interface UseAppUpdaterResult {
  state: AppUpdateState
  isLoading: boolean
  error: string | null
  checkForUpdates: () => Promise<AppUpdateState>
  downloadUpdate: () => Promise<AppUpdateState>
  quitAndInstall: () => Promise<void>
  skipVersion: (version: string) => Promise<AppUpdateState>
  setAutoDownload: (enabled: boolean) => Promise<AppUpdateState>
  setAutoCheck: (enabled: boolean) => Promise<AppUpdateState>
}

interface AppUpdaterSnapshot {
  state: AppUpdateState
  isLoading: boolean
  error: string | null
}

/**
 * One renderer-wide updater store. Every consumer used to keep its own state, fire
 * its own `getState()` on mount and register its own `onUpdaterStateChanged`
 * listener — so a download-progress broadcast (several per second) fanned out into
 * one setState per consumer, one of which sits at the App root and re-rendered the
 * whole tree. Now a single subscription feeds a shared snapshot, and consumers that
 * only need a slice (see `useAppUpdaterSelector`) stay put while the percent moves.
 *
 * Nothing is cached beyond "the last state main broadcast": main pushes on every
 * transition (check, no-update, available, each progress tick, downloaded, error,
 * pref change), and the store re-reads `getState()` whenever it goes from zero
 * consumers back to one — so a "no update available" result can never stick.
 */
let snapshot: AppUpdaterSnapshot = {
  state: DEFAULT_STATE,
  isLoading: true,
  error: null
}

const listeners = new Set<() => void>()
let unsubscribeFromMain: (() => void) | null = null

function emit(next: AppUpdaterSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** A fresh state from main clears any previously surfaced error. */
function publishState(state: AppUpdateState): void {
  emit({ state, isLoading: false, error: null })
}

function publishError(message: string): void {
  emit({ ...snapshot, isLoading: false, error: message })
}

function getSnapshot(): AppUpdaterSnapshot {
  return snapshot
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  if (listeners.size === 1) {
    unsubscribeFromMain = window.api.onUpdaterStateChanged(publishState)
    void window.api.updater
      .getState()
      .then(publishState)
      .catch((err) => {
        publishError(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadUpdaterState')
          )
        )
      })
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribeFromMain?.()
      unsubscribeFromMain = null
      snapshot = { state: DEFAULT_STATE, isLoading: true, error: null }
    }
  }
}

/**
 * Subscribe to a slice of the shared updater state. Re-renders only when the
 * selected value changes by `Object.is`, so a consumer that reads (say) the
 * install flag is untouched by download-progress ticks. Selectors must return a
 * primitive or an already-stable reference.
 */
export function useAppUpdaterSelector<T>(selector: (state: AppUpdateState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(snapshot.state))
}

export function useAppUpdater(): UseAppUpdaterResult {
  const { state, isLoading, error } = useSyncExternalStore(subscribe, getSnapshot)

  const checkForUpdates = useCallback(async (): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.checkForUpdates()
      publishState(nextState)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  const downloadUpdate = useCallback(async (): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.downloadUpdate()
      publishState(nextState)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToDownloadUpdate')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  const quitAndInstall = useCallback(async (): Promise<void> => {
    try {
      await window.api.updater.quitAndInstall()
      // Install returns no state of its own; just drop any error the UI is showing.
      emit({ ...snapshot, error: null })
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToInstallUpdate')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  const skipVersion = useCallback(async (version: string): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.skipVersion(version)
      publishState(nextState)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  const setAutoDownload = useCallback(async (enabled: boolean): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.setAutoDownload(enabled)
      publishState(nextState)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  const setAutoCheck = useCallback(async (enabled: boolean): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.setAutoCheck(enabled)
      publishState(nextState)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      publishError(message)
      throw new Error(message)
    }
  }, [])

  return {
    state,
    isLoading,
    error,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    skipVersion,
    setAutoDownload,
    setAutoCheck
  }
}
