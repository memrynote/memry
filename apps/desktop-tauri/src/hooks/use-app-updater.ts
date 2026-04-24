import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
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

    void invoke<AppUpdateState>('updater_get_state')
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

    const unsubscribe = subscribeEvent<AppUpdateState>('updater-state-changed', (nextState) => {
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
      const nextState = await invoke<AppUpdateState>('updater_check_for_updates')
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
      const nextState = await invoke<AppUpdateState>('updater_download_update')
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
      await invoke('updater_quit_and_install')
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
