import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

const DEFAULT_STATE: AppUpdateState = {
  currentVersion: '0.0.0',
  status: 'unavailable',
  updateSupported: false,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null
}

interface UseAppUpdaterResult {
  state: AppUpdateState
  isLoading: boolean
  error: string | null
  checkForUpdates: () => Promise<AppUpdateState>
  downloadUpdate: () => Promise<AppUpdateState>
  quitAndInstall: () => Promise<void>
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
          setError(extractErrorMessage(err, 'Failed to load updater state'))
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
      const message = extractErrorMessage(err, 'Failed to check for updates')
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
      const message = extractErrorMessage(err, 'Failed to download update')
      setError(message)
      throw new Error(message)
    }
  }, [])

  const quitAndInstall = useCallback(async (): Promise<void> => {
    try {
      await window.api.updater.quitAndInstall()
      setError(null)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to install update')
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
    quitAndInstall
  }
}
