import { useState, useEffect, useCallback, useRef } from 'react'
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
import { clearVaultSidebarSnapshot } from '@/lib/vault-sidebar-snapshot'
import { clearTaskOrderForVault } from '@/hooks/use-task-order'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { runVaultLeaveFlushes } from '@/lib/vault-workspace-lifecycle'
import { useVaultScope } from '@/contexts/vault-scope'
import {
  getCachedVaultList,
  getCachedVaultStatus,
  setCachedVaultList,
  setCachedVaultStatus
} from '@/lib/vault-status-cache'
import {
  beginVaultSwitch,
  endVaultSwitch,
  getVaultSwitchState,
  isVaultRevealHeld,
  subscribeVaultSwitchState,
  type VaultSwitchDirection
} from '@/lib/vault-switch-state'

export interface SwitchVaultOptions {
  /** Display name for the in-between screen; defaults to the folder name. */
  name?: string
  accentColor?: string
  /** Set by the sidebar gesture so the incoming vault can enter from that side. */
  direction?: VaultSwitchDirection
}

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
  const scope = useVaultScope()
  // Seeded from the last status any instance applied, so a workspace mounting
  // mid-switch draws its vault on the first frame (see `vault-status-cache`).
  // A scoped instance only takes its own vault's status, as in `applyStatus`.
  const [status, setStatusState] = useState<VaultStatus | null>(() => {
    const cached = getCachedVaultStatus()
    return cached && (scope === null || cached.path === scope) ? cached : null
  })
  const [config, setConfig] = useState<VaultConfig | null>(null)
  const [isLoading, setIsLoading] = useState(() => status === null)
  const [error, setError] = useState<string | null>(null)
  const [recoveryInfo, setRecoveryInfo] = useState<IndexRecoveredEvent | null>(null)
  const latestStatusRef = useRef<VaultStatus | null>(null)

  const setStatus = useCallback((next: VaultStatus) => {
    setCachedVaultStatus(next)
    setStatusState(next)
  }, [])

  /**
   * A switch closes the open vault before it opens the next, and main reports
   * that gap as `isOpen: false`. Passed through, every consumer drops the
   * outgoing vault for a frame or two (App unmounts the workspace, the sidebar
   * loses its pager), which is the flash between vaults. While a switch is in
   * flight the gap is held back; the latest status lands when the switch ends,
   * so a failed switch still surfaces the closed state.
   *
   * Inside a vault workspace, only that vault's status is taken: a workspace
   * kept mounted for a vault the user left must not start rendering the next
   * vault's path, or it would show it for a frame when it is revealed again.
   */
  const applyStatus = useCallback(
    (next: VaultStatus) => {
      if (scope !== null && next.path !== scope) return
      latestStatusRef.current = next
      if (!next.isOpen && getVaultSwitchState().pending) return
      // The pager is still settling: the incoming vault is revealed once it is
      // done, with whatever status is latest by then.
      if (isVaultRevealHeld()) return
      setStatus(next)
    },
    [scope, setStatus]
  )

  useEffect(
    () =>
      subscribeVaultSwitchState(() => {
        const latest = latestStatusRef.current
        if (!latest || isVaultRevealHeld()) return
        if (!latest.isOpen && getVaultSwitchState().pending) return
        setStatus(latest)
      }),
    [setStatus]
  )

  // Load initial status and config
  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const [vaultStatus, vaultConfig] = await Promise.all([
          vaultService.getStatus(),
          vaultService.getConfig()
        ])
        applyStatus(vaultStatus)
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
  }, [applyStatus])

  // Subscribe to vault events
  useEffect(() => {
    const unsubStatus = onVaultStatusChanged((newStatus) => {
      applyStatus(newStatus)
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
  }, [applyStatus])

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
  const switchVault = useCallback(
    async (vaultPath: string, options: SwitchVaultOptions = {}): Promise<SelectVaultResponse> => {
      // One switch at a time. Starting another would overwrite the running
      // switch's target, and its `endVaultSwitch` would then clear this one's.
      if (getVaultSwitchState().pending) {
        return {
          success: false,
          vault: null,
          error: getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToSwitchVault')
        }
      }
      setIsLoading(true)
      setError(null)
      // Marks the closed-vault gap as a switch, so App keeps the shell up instead
      // of onboarding, and the incoming vault restores its whole tab session.
      beginVaultSwitch(
        {
          path: vaultPath,
          name: options.name ?? (vaultPath.split(/[\\/]/).pop() || vaultPath),
          accentColor: options.accentColor
        },
        options.direction ?? null
      )
      let switched = false

      try {
        // Edits still in their debounce belong to the vault being left. Its
        // workspace stays mounted (hidden) after the switch, so nothing else
        // would write them before main closes the vault. Editors first: their
        // flush hands markdown to the page saves the registry then writes.
        await runVaultLeaveFlushes()
        await flushAllPendingSaves()
        const result = await vaultService.switch(vaultPath)
        switched = result.success

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
        endVaultSwitch(switched)
        setIsLoading(false)
      }
    },
    []
  )

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
    indexBuilt: status?.indexBuilt,
    indexTotal: status?.indexTotal,
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
  // Seeded like `useVault`: the incoming workspace's sidebar needs the list on
  // its first frame to draw the pager and the indicator, not a frame later.
  const [vaults, setVaults] = useState<VaultInfo[]>(() => getCachedVaultList()?.vaults ?? [])
  const [currentVault, setCurrentVault] = useState<string | null>(
    () => getCachedVaultList()?.currentVault ?? null
  )
  const [isLoading, setIsLoading] = useState(() => getCachedVaultList() === null)

  const apply = useCallback((result: { vaults: VaultInfo[]; currentVault: string | null }) => {
    setCachedVaultList({ vaults: result.vaults, currentVault: result.currentVault })
    setVaults(result.vaults)
    setCurrentVault(result.currentVault)
  }, [])

  useEffect(() => {
    const loadVaults = async () => {
      try {
        apply(await vaultService.getAll())
      } finally {
        setIsLoading(false)
      }
    }

    void loadVaults()
  }, [apply])

  const refresh = useCallback(async () => {
    apply(await vaultService.getAll())
  }, [apply])

  const removeVault = useCallback(
    async (path: string) => {
      await vaultService.remove(path)
      // The removed vault's tabs would otherwise sit on the origin's quota
      // forever, competing with the tab state of vaults the user still opens.
      clearTabStateForVault(path)
      clearVaultSidebarSnapshot(path)
      clearTaskOrderForVault(path)
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
