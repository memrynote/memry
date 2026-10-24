import { useState, useEffect, useCallback } from 'react'

interface StorageBreakdownData {
  used: number
  limit: number
  breakdown: {
    notes: number
    attachments: number
    crdt: number
    other: number
  }
}

export function useStorageUsage() {
  const [data, setData] = useState<StorageBreakdownData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.syncOps.getStorageBreakdown()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch storage usage')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const result = await window.api.syncOps.getStorageBreakdown()
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to fetch storage usage')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()

    return () => {
      cancelled = true
    }
  }, [])

  return { data, loading, error, refresh }
}
