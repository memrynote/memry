import { useCallback, useState } from 'react'
import { useVaultScope } from '@/contexts/vault-scope'
import { getCachedVaultStatus } from '@/lib/vault-status-cache'
import { createLogger } from '@/lib/logger'

const log = createLogger('WordCountVisible')

const STORAGE_PREFIX = 'memry:note-word-count:'
const VISIBLE_VALUE = '1'

const storageKey = (vaultKey: string): string => `${STORAGE_PREFIX}${vaultKey}`

const readVisible = (vaultKey: string): boolean => {
  try {
    return localStorage.getItem(storageKey(vaultKey)) === VISIBLE_VALUE
  } catch (error) {
    log.warn('Failed to read word count visibility from localStorage', error)
    return false
  }
}

const persist = (vaultKey: string, visible: boolean): void => {
  try {
    if (visible) localStorage.setItem(storageKey(vaultKey), VISIBLE_VALUE)
    else localStorage.removeItem(storageKey(vaultKey))
  } catch (error) {
    log.warn('Failed to persist word count visibility to localStorage', error)
  }
}

/**
 * Whether the note chrome shows the live word count. Device-local and per
 * vault (keyed by the vault path), off by default.
 */
export function useWordCountVisible(): readonly [boolean, () => void] {
  const vaultKey = useVaultScope() ?? getCachedVaultStatus()?.path ?? ''
  const [state, setState] = useState(() => ({ vaultKey, visible: readVisible(vaultKey) }))

  let current = state
  if (current.vaultKey !== vaultKey) {
    current = { vaultKey, visible: readVisible(vaultKey) }
    setState(current)
  }

  const currentVisible = current.visible
  const toggle = useCallback(() => {
    const visible = !currentVisible
    persist(vaultKey, visible)
    setState({ vaultKey, visible })
  }, [vaultKey, currentVisible])

  return [current.visible, toggle] as const
}
