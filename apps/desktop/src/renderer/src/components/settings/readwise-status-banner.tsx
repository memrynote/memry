/**
 * The Readwise status banner (#1418, variant B). One shape for every state:
 * an icon, what is happening, one line of detail, and at most one action.
 * Quiet when healthy, honest when not (D19).
 */

import { useState, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ReadwiseRunCounts, ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { AlertCircle, CheckCircle2, Clock, CloudOff, Monitor } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatRelativeFuture } from '@/lib/format-relative-future'
import { formatRelativePast } from '@/lib/format-relative-past'
import { deriveReadwiseState } from '@/components/settings/readwise-state'

type Tone = 'neutral' | 'warning' | 'error'

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border bg-muted/40',
  warning: 'border-amber-500/40 bg-amber-500/10',
  error: 'border-destructive/40 bg-destructive/10'
}

const ICON_CLASSES: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive'
}

interface ReadwiseStatusBannerProps {
  status: ReadwiseStatusResult
  /**
   * An action shows only where its handler is given: Retry now runs a sync,
   * Cancel stops one, New token opens the field that replaces a rejected token,
   * Sync here opens the takeover form (this is not the pulling device).
   */
  onRetry?: () => void
  onCancel?: () => void
  onPasteNew?: () => void
  onSyncHere?: () => void
  /** A retry is already running, so its button waits. */
  busy?: boolean
}

export function ReadwiseStatusBanner({
  status,
  onRetry,
  onCancel,
  onPasteNew,
  onSyncHere,
  busy = false
}: ReadwiseStatusBannerProps) {
  const { t, i18n } = useT('settings')
  const state = deriveReadwiseState(status)
  const key = 'import.dialog.readwise.status'
  const when = (iso: string): string => formatRelativeFuture(iso, i18n.language)

  const counts = (c: ReadwiseRunCounts): string => {
    const parts = [
      c.added > 0 && t(`${key}.counts.added`, { count: c.added }),
      c.updated > 0 && t(`${key}.counts.updated`, { count: c.updated }),
      c.appended > 0 && t(`${key}.counts.appended`, { count: c.appended }),
      c.highlights > 0 && t(`${key}.counts.highlights`, { count: c.highlights }),
      c.deferred > 0 && t(`${key}.counts.deferred`, { count: c.deferred }),
      c.failed > 0 && t(`${key}.counts.failed`, { count: c.failed })
    ].filter((part): part is string => typeof part === 'string')
    return parts.length === 0
      ? t(`${key}.lastRunNothing`)
      : t(`${key}.lastRun`, {
          counts: new Intl.ListFormat(i18n.language, { style: 'short', type: 'unit' }).format(parts)
        })
  }

  let tone: Tone = 'neutral'
  let icon: ReactNode = <CheckCircle2 aria-hidden="true" className="size-4" />
  let title: string
  let detail: string[] = []
  let action: { label: string; onClick: () => void; disabled?: boolean } | null = null

  switch (state.kind) {
    case 'not-connected':
      return null
    case 'other-device':
      icon = <Monitor aria-hidden="true" className="size-4" />
      title = state.deviceName
        ? t(`${key}.otherTitle`, { device: state.deviceName })
        : t(`${key}.otherTitleUnknown`)
      detail = [t(`${key}.otherDetail`)]
      if (onSyncHere) action = { label: t(`${key}.actions.syncHere`), onClick: onSyncHere }
      break
    case 'waiting-for-sync':
      icon = <Clock aria-hidden="true" className="size-4" />
      title = t(`${key}.waitingTitle`)
      detail = [t(`${key}.waitingDetail`)]
      if (onCancel) action = { label: t(`${key}.actions.cancel`), onClick: onCancel }
      break
    case 'syncing':
      icon = <Spinner className="size-4 motion-reduce:animate-none" />
      title = t(`${key}.syncing`)
      detail = [
        state.planned === null
          ? t(`${key}.reading`)
          : state.planned === 0
            ? t(`${key}.finishing`)
            : t(`${key}.writing`, { done: state.done, total: state.planned })
      ]
      if (onCancel) action = { label: t(`${key}.actions.cancel`), onClick: onCancel }
      break
    case 'error': {
      const fixable = state.error === 'invalid-token' || state.error === 'subscription-expired'
      tone = fixable ? 'error' : 'warning'
      icon =
        state.error === 'network' ? (
          <CloudOff aria-hidden="true" className="size-4" />
        ) : (
          <AlertCircle aria-hidden="true" className="size-4" />
        )
      title = t(`${key}.errors.${state.error}.title`)
      detail = [state.detail ?? t(`${key}.errors.${state.error}.detail`)]
      // A parked schedule never retries by itself; the others say when they will.
      if (!fixable && status.nextRunAt) {
        detail.push(t(`${key}.retryAt`, { time: when(status.nextRunAt) }))
      }
      if (state.error === 'invalid-token') {
        if (onPasteNew) action = { label: t(`${key}.actions.newToken`), onClick: onPasteNew }
      } else if (onRetry) {
        action = { label: t(`${key}.actions.retry`), onClick: onRetry, disabled: busy }
      }
      break
    }
    case 'synced':
    case 'connected':
      title =
        state.kind === 'synced'
          ? t(`${key}.synced`, { time: formatRelativePast(state.at, i18n.language) })
          : t(`${key}.connected`)
      if (status.lastRun) detail.push(counts(status.lastRun))
      if (status.nextRunAt) detail.push(t(`${key}.nextRun`, { time: when(status.nextRunAt) }))
      break
  }

  return (
    <div
      role={state.kind === 'error' ? 'alert' : 'status'}
      data-testid="readwise-status-banner"
      data-state={state.kind === 'error' ? `error:${state.error}` : state.kind}
      className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5', TONE_CLASSES[tone])}
    >
      <span className={cn('shrink-0', ICON_CLASSES[tone])}>{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13px]/4 font-medium text-foreground">{title}</p>
        {detail.length > 0 && (
          <p className="text-xs/4 text-muted-foreground">{detail.join(' · ')}</p>
        )}
      </div>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}

interface ReadwiseReconnectFormProps {
  error: string | null
  busy: boolean
  disabled: boolean
  onSubmit: (token: string) => void
  onCancel: () => void
}

/** Replaces a rejected token without losing the cursor: connecting again keeps the run state. */
export function ReadwiseReconnectForm({
  error,
  busy,
  disabled,
  onSubmit,
  onCancel
}: ReadwiseReconnectFormProps) {
  const { t } = useT('settings')
  const [token, setToken] = useState('')
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (token.trim() && !busy) onSubmit(token)
      }}
    >
      <label htmlFor="readwise-new-token" className="text-[13px]/4 text-foreground">
        {t('import.dialog.readwise.tokenLabel')}
      </label>
      <Input
        id="readwise-new-token"
        type="password"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={token}
        onChange={(event) => {
          setToken(event.target.value)
        }}
        placeholder={t('import.dialog.readwise.tokenPlaceholder')}
        aria-invalid={error !== null}
        aria-describedby={error ? 'readwise-new-token-error' : undefined}
        disabled={disabled || busy}
        className="h-8 font-mono text-xs/4"
      />
      {error && (
        <p id="readwise-new-token-error" role="alert" className="text-xs/4 text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('import.dialog.readwise.status.actions.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={disabled || busy || !token.trim()}>
          {t('import.dialog.readwise.status.actions.reconnect')}
        </Button>
      </div>
    </form>
  )
}
