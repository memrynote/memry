/**
 * The Readwise panel on a device that does not pull (#1408 D8): names the
 * device that does, and offers "Sync here instead". The token never
 * travels between devices (D2), so taking over asks for it again.
 */

import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ReadwiseStatusBanner } from '@/components/settings/readwise-status-banner'
import { extractErrorMessage, unwrapIpcResult as unwrap } from '@/lib/ipc-error'

interface ReadwiseTakeoverSectionProps {
  status: ReadwiseStatusResult
  disabled: boolean
  onTakenOver: (status: ReadwiseStatusResult) => void
}

export function ReadwiseTakeoverSection({
  status,
  disabled,
  onTakenOver
}: ReadwiseTakeoverSectionProps) {
  const { t } = useT('settings')
  const [token, setToken] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const takeOver = async () => {
    if (!token.trim() || isWorking) return
    setIsWorking(true)
    setError(null)
    try {
      const next = unwrap(
        await window.api.import.readwise.takeOver({ token }),
        t('import.dialog.readwise.takeOver.failed')
      )
      if (!mountedRef.current) return
      setToken('')
      onTakenOver(next)
    } catch (err) {
      if (mountedRef.current) {
        setError(extractErrorMessage(err, t('import.dialog.readwise.takeOver.failed')))
      }
    } finally {
      if (mountedRef.current) setIsWorking(false)
    }
  }

  const banner = (
    <ReadwiseStatusBanner
      status={status}
      onSyncHere={
        asking
          ? undefined
          : () => {
              setAsking(true)
            }
      }
    />
  )
  if (!asking) return <div className="flex min-w-0 flex-col gap-3">{banner}</div>

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void takeOver()
      }}
    >
      {banner}
      <p className="text-xs/4 text-muted-foreground">
        {t('import.dialog.readwise.takeOver.explain')}
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="readwise-takeover-token" className="text-[13px]/4 text-foreground">
          {t('import.dialog.readwise.tokenLabel')}
        </label>
        <Input
          id="readwise-takeover-token"
          type="password"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            setToken(event.target.value)
            setError(null)
          }}
          placeholder={t('import.dialog.readwise.tokenPlaceholder')}
          aria-invalid={error !== null}
          aria-describedby={error ? 'readwise-takeover-error' : undefined}
          disabled={disabled || isWorking}
          className="h-8 font-mono text-xs/4"
        />
        {error && (
          <p id="readwise-takeover-error" role="alert" className="text-xs/4 text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={disabled || isWorking || !token.trim()}>
          {isWorking
            ? t('import.dialog.readwise.takeOver.working')
            : t('import.dialog.readwise.takeOver.button')}
        </Button>
      </div>
    </form>
  )
}
