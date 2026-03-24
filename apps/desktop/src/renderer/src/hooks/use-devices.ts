import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { deviceService } from '@/services/device-service'

export interface Device {
  id: string
  name: string
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  linkedAt: number
  lastSyncAt?: number
  isCurrentDevice: boolean
}

interface UseDevicesReturn {
  devices: Device[]
  email: string | undefined
  isLoading: boolean
  error: string | null
  removeDevice: (deviceId: string) => Promise<boolean>
  refresh: () => void
}

export function useDevices(): UseDevicesReturn {
  const [devices, setDevices] = useState<Device[]>([])
  const [email, setEmail] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await deviceService.getDevices()
        if (mounted) {
          setDevices(result.devices as Device[])
          setEmail(result.email)
        }
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load devices'))
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [refreshKey])

  const removeDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    try {
      const result = await deviceService.removeDevice({ deviceId })
      if (result.success) {
        setDevices((prev) => prev.filter((d) => d.id !== deviceId))
        return true
      }
      setError(result.error ?? 'Failed to remove device')
      return false
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to remove device'))
      return false
    }
  }, [])

  return {
    devices,
    email,
    isLoading,
    error,
    removeDevice,
    refresh: () => setRefreshKey((k) => k + 1)
  }
}
