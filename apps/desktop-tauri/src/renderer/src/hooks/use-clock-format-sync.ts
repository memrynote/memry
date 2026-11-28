import { useEffect } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { setClockFormatPref } from '@/lib/time-format'

// Mirrors the General `clockFormat` setting into time-format's module cache so
// pure (non-React) time formatting follows it. Mount once at the app root.
export function useClockFormatSync(): void {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  useEffect(() => {
    setClockFormatPref(clockFormat)
  }, [clockFormat])
}
