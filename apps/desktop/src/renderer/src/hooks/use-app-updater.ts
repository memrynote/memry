import { useCallback, useEffect, useState } from 'react'
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

export function useAppUpdater(): UseAppUpdaterResult {
  const [state, setState] = useState<AppUpdateState>(DEFAULT_STATE)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    void window.api.updater
      .getState()
      .then((nextState) => {
        if (mounted) {
          setState(nextState)
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadUpdaterState')
            )
          )
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false)
        }
      })

    const unsubscribe = window.api.onUpdaterStateChanged((nextState) => {
      setState(nextState)
      setError(null)
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const checkForUpdates = useCallback(async (): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.checkForUpdates()
      setState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      setError(message)
      throw new Error(message)
    }
  }, [])

  const downloadUpdate = useCallback(async (): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.downloadUpdate()
      setState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToDownloadUpdate')
      )
      setError(message)
      throw new Error(message)
    }
  }, [])

  const quitAndInstall = useCallback(async (): Promise<void> => {
    try {
      await window.api.updater.quitAndInstall()
      setError(null)
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToInstallUpdate')
      )
      setError(message)
      throw new Error(message)
    }
  }, [])

  const skipVersion = useCallback(async (version: string): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.skipVersion(version)
      setState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      setError(message)
      throw new Error(message)
    }
  }, [])

  const setAutoDownload = useCallback(async (enabled: boolean): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.setAutoDownload(enabled)
      setState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      setError(message)
      throw new Error(message)
    }
  }, [])

  const setAutoCheck = useCallback(async (enabled: boolean): Promise<AppUpdateState> => {
    try {
      const nextState = await window.api.updater.setAutoCheck(enabled)
      setState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCheckForUpdates')
      )
      setError(message)
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
