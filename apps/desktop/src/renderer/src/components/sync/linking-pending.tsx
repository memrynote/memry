import { useEffect, useRef, useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Loader2, X, CheckCircle, AlertCircle } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

const POLL_INTERVAL_MS = 3000

function formatSasCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

interface LinkingVaultSummary {
  vaultUuid: string
  itemCount?: number
  createdAt?: number | null
}

interface LinkingPendingProps {
  sessionId: string
  verificationCode?: string
  onComplete: () => void
  onPickVaults: (vaults: LinkingVaultSummary[]) => void
  onError: (error: string) => void
  onCancel: () => void
}

export function LinkingPending({
  sessionId,
  verificationCode,
  onComplete,
  onPickVaults,
  onError,
  onCancel
}: LinkingPendingProps): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const [status, setStatus] = useState<'waiting' | 'completing' | 'error'>('waiting')
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const poll = useCallback(async () => {
    if (cancelledRef.current) return

    try {
      const result = await window.api.syncLinking.completeLinkingQr({ sessionId })

      if (cancelledRef.current) return

      if (result.success) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        if (result.vaults && result.vaults.length >= 2) {
          onPickVaults(result.vaults)
          return
        }
        setStatus('completing')
        onComplete()
        return
      }

      if (result.error && result.error !== 'Session not yet approved') {
        if (result.error.includes('Too many requests')) return
        setStatus('error')
        setError(result.error)
        if (intervalRef.current) clearInterval(intervalRef.current)
        onError(result.error)
      }
    } catch (err) {
      if (cancelledRef.current) return
      const msg = extractErrorMessage(err, t('setup.linking.deviceFailed'))
      if (msg.includes('Too many requests')) return
      setStatus('error')
      setError(msg)
      if (intervalRef.current) clearInterval(intervalRef.current)
      onError(msg)
    }
  }, [sessionId, onComplete, onPickVaults, onError, t])

  useEffect(() => {
    cancelledRef.current = false

    const initialTimer = setTimeout(() => void poll(), 0)
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      cancelledRef.current = true
      clearTimeout(initialTimer)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [poll])

  if (status === 'completing') {
    return (
      <div className="wizard-step-enter flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-14 h-14 rounded-2xl bg-green-500/10 dark:bg-green-400/10 flex items-center justify-center">
          <CheckCircle className="w-7 h-7 text-green-600 dark:text-green-400" />
        </div>
        <p className="font-serif text-[15px] text-muted-foreground">
          {t('setup.linking.pendingSuccess')}
        </p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="wizard-step-enter flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-7 h-7 text-destructive" />
        </div>
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('setup.linking.goBack')}
        </Button>
      </div>
    )
  }

  return (
    <div
      className="wizard-step-enter flex flex-col items-center justify-center py-12 gap-4"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-10 h-10 animate-spin text-[var(--tint)]" aria-hidden="true" />
      <div className="text-center space-y-1">
        <p className="font-display text-lg tracking-tight">{t('setup.linking.waitingTitle')}</p>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed max-w-xs">
          {t('setup.linking.waitingDescription')}
        </p>
      </div>
      {verificationCode && (
        <div className="rounded-md border border-border bg-muted/50 px-6 py-3 text-center space-y-1">
          <p className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
            {t('setup.linking.verificationCode')}
          </p>
          <p className="font-mono text-2xl tracking-[0.3em] font-semibold text-[var(--tint)]">
            {formatSasCode(verificationCode)}
          </p>
          <p className="text-xs text-muted-foreground">{t('setup.linking.confirmCode')}</p>
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="gap-1.5 text-muted-foreground mt-2"
      >
        <X className="w-3.5 h-3.5" />
        {tCommon('button.cancel')}
      </Button>
    </div>
  )
}
