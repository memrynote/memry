import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type {
  VaultStatus,
  VaultConfig,
  VaultInfo,
  SelectVaultResponse,
  IndexRecoveredEvent
} from '../../../preload/index.d'
import {
  vaultService,
  onVaultStatusChanged,
  onVaultIndexProgress,
  onVaultError,
  onVaultIndexRecovered
} from '../services/vault-service'
import { getI18n } from 'react-i18next'
import { clearTabStateForVault } from '@/contexts/tabs/persistence'

/**
 * Hook for vault state management.
 * Provides vault status, loading states, and actions for vault operations.
 *
 * @example
 * ```tsx
 * function VaultSelector() {
 *   const { status, isLoading, error, selectVault } = useVault()
 *
 *   if (isLoading) return <div>Loading...</div>
 *   if (error) return <div>Error: {error}</div>
 *
 *   if (!status?.isOpen) {
 *     return <button onClick={() => selectVault()}>Select Vault</button>
 *   }
 *
 *   return <div>Vault: {status.path}</div>
 * }
 * ```
 */
export function useVault() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [config, setConfig] = useState<VaultConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recoveryInfo, setRecoveryInfo] = useState<IndexRecoveredEvent | null>(null)

  // Load initial status and config
  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const [vaultStatus, vaultConfig] = await Promise.all([
          vaultService.getStatus(),
          vaultService.getConfig()
        ])
        setStatus(vaultStatus)
        setConfig(vaultConfig)
        setError(extractErrorMessage(vaultStatus.error, ''))
      } catch (err) {
        const message = extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadVaultStatus')
        )
        setError(message)
      } finally {
        setIsLoading(false)
      }
    }

    void loadInitialState()
  }, [])

  // Subscribe to vault events
  useEffect(() => {
    const unsubStatus = onVaultStatusChanged((newStatus) => {
      setStatus(newStatus)
      if (newStatus.error) {
        setError(extractErrorMessage(newStatus.error, ''))
      }
    })

    const unsubProgress = onVaultIndexProgress((_progress) => {
      // Progress is tracked in status.indexProgress, but this event
      // can be used for more granular updates if needed
    })

    const unsubError = onVaultError((errorMsg) => {
      setError(extractErrorMessage(errorMsg, ''))
    })

    let recoveryClearTimer: ReturnType<typeof setTimeout> | undefined

    const unsubRecovered = onVaultIndexRecovered((event) => {
      setRecoveryInfo(event)
      // Auto-clear recovery info after 10 seconds
      clearTimeout(recoveryClearTimer)
      recoveryClearTimer = setTimeout(() => setRecoveryInfo(null), 10000)
    })

    return () => {
      unsubStatus()
      unsubProgress()
      unsubError()
      unsubRecovered()
      clearTimeout(recoveryClearTimer)
    }
  }, [])

  /**
   * Select a vault folder. Shows folder picker if no path provided.
   */
  const selectVault = useCallback(async (path?: string): Promise<SelectVaultResponse> => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await vaultService.select(path)

      if (!result.success) {
        setError(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSelectVault')
          )
        )
      } else {
        // Refresh config after vault selection
        const newConfig = await vaultService.getConfig()
        setConfig(newConfig)
      }

      return result
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSelectVault')
      )
      setError(message)
      return { success: false, vault: null, error: message }
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Close the current vault.
   */
  const closeVault = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setError(null)

    try {
      await vaultService.close()
      setConfig(null)
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToCloseVault')
      )
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Switch to a different vault.
   */
  const switchVault = useCallback(async (vaultPath: string): Promise<SelectVaultResponse> => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await vaultService.switch(vaultPath)

      if (!result.success) {
        setError(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
          )
        )
      } else {
        const newConfig = await vaultService.getConfig()
        setConfig(newConfig)
      }

      return result
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
      )
      setError(message)
      return { success: false, vault: null, error: message }
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Update vault configuration.
   */
  const updateConfig = useCallback(async (updates: Partial<VaultConfig>): Promise<void> => {
    try {
      const newConfig = await vaultService.updateConfig(updates)
      setConfig(newConfig)
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateConfig')
      )
      setError(message)
    }
  }, [])

  /**
   * Trigger manual reindex.
   */
  const reindex = useCallback(async (): Promise<void> => {
    setError(null)

    try {
      await vaultService.reindex()
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToReindex')
      )
      setError(message)
    }
  }, [])

  /**
   * Clear error state.
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  /**
   * Clear recovery info state.
   */
  const clearRecoveryInfo = useCallback(() => {
    setRecoveryInfo(null)
  }, [])

  return {
    // State
    status,
    config,
    isLoading,
    error,
    recoveryInfo,

    // Computed
    isOpen: status?.isOpen ?? false,
    isIndexing: status?.isIndexing ?? false,
    indexProgress: status?.indexProgress ?? 0,
    vaultPath: status?.path ?? null,

    // Actions
    selectVault,
    closeVault,
    switchVault,
    updateConfig,
    reindex,
    clearError,
    clearRecoveryInfo
  }
}

/**
 * Hook for getting the list of all known vaults.
 */
export function useVaultList() {
  const [vaults, setVaults] = useState<VaultInfo[]>([])
  const [currentVault, setCurrentVault] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadVaults = async () => {
      try {
        const result = await vaultService.getAll()
        setVaults(result.vaults)
        setCurrentVault(result.currentVault)
      } finally {
        setIsLoading(false)
      }
    }

    void loadVaults()
  }, [])

  const refresh = useCallback(async () => {
    const result = await vaultService.getAll()
    setVaults(result.vaults)
    setCurrentVault(result.currentVault)
  }, [])

  const removeVault = useCallback(
    async (path: string) => {
      await vaultService.remove(path)
      // The removed vault's tabs would otherwise sit on the origin's quota
      // forever, competing with the tab state of vaults the user still opens.
      clearTabStateForVault(path)
      await refresh()
    },
    [refresh]
  )

  return {
    vaults,
    currentVault,
    isLoading,
    refresh,
    removeVault
  }
}
