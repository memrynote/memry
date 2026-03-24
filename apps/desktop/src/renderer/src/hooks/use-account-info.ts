import { useState, useEffect } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'

export interface AccountInfo {
  email: string | null
  joinedAt: number | null
}

interface UseAccountInfoReturn {
  accountInfo: AccountInfo | null
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useAccountInfo(): UseAccountInfoReturn {
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await window.api.account.getInfo()
        if (mounted) setAccountInfo(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load account info'))
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [refreshKey])

  return {
    accountInfo,
    isLoading,
    error,
    refresh: () => setRefreshKey((k) => k + 1)
  }
}
