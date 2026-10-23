import { useCallback, useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { unwrapIpcResult } from '@/lib/ipc-error'

/**
 * Readwise connection state for the Settings → Import row. The panel owns its
 * own copy while open, so `refresh` lets the row re-read after the dialog closes.
 */
export function useReadwiseStatus(enabled: boolean): {
  status: ReadwiseStatusResult | null
  refresh: () => void
} {
  const { t } = useT('settings')
  const [status, setStatus] = useState<ReadwiseStatusResult | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void window.api.import.readwise
      .status()
      .then((raw) => {
        if (active) setStatus(unwrapIpcResult(raw, t('import.dialog.error')))
      })
      .catch(() => {
        // The row falls back to its plain "Account" label.
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- dependency is an intentional re-run trigger (token/identity), not read by the effect
  }, [enabled, nonce, t])

  // A run starting, moving on or ending changes what the row says.
  useEffect(() => {
    if (!enabled) return
    return window.api.onReadwiseStatusChanged(() => {
      setNonce((n) => n + 1)
    })
  }, [enabled])

  const refresh = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])
  return { status, refresh }
}
