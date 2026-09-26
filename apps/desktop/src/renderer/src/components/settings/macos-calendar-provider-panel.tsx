import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  CalendarProviderDescriptor,
  CalendarProviderStatus,
  CalendarSourceRecord
} from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { Laptop } from '@/lib/icons'
import { calendarService } from '@/services/calendar-service'
import { createLogger } from '@/lib/logger'
import { GenericCalendarProviderPanel } from '@/components/settings/generic-calendar-provider-panel'
import {
  CALENDAR_BORDERED_BUTTON,
  CALENDAR_QUIET_BUTTON
} from '@/components/settings/calendar-provider-row'

const log = createLogger('MacosCalendarProviderPanel')

/** Codes main returns (`permission_*`, `unavailable`, `sync_failed`) that have their own copy. */
const KNOWN_ERRORS = new Set([
  'permission_denied',
  'permission_restricted',
  'permission_write_only',
  'permission_not_determined',
  'unavailable',
  'sync_failed'
])
/** Only these can be fixed from System Settings; `restricted` is decided by whoever manages the Mac. */
const FIXABLE_IN_SYSTEM_SETTINGS = new Set(['permission_denied', 'permission_write_only'])

function useErrorCopy(): (code: string) => string {
  const { t } = useT('settings')
  return (code) =>
    KNOWN_ERRORS.has(code)
      ? t(`calendar.providers.appleEventKit.errors.${code}`)
      : t('calendar.providers.connectFailed')
}

function openSystemSettings(): void {
  void calendarService.openOsCalendarSettings().catch((error: unknown) => {
    log.warn('Could not open System Settings', error)
  })
}

/** What went wrong, and the button that fixes it when there is one. */
function PermissionProblem({
  code,
  onCheckAgain,
  checking
}: {
  code: string
  onCheckAgain?: () => void
  checking?: boolean
}): React.JSX.Element {
  const { t } = useT('settings')
  const copy = useErrorCopy()
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5"
      data-testid="macos-calendar-problem"
      data-code={code}
    >
      <p className="text-xs/4 text-foreground">{copy(code)}</p>
      <div className="flex flex-wrap items-center gap-4">
        {FIXABLE_IN_SYSTEM_SETTINGS.has(code) && (
          <button type="button" className={CALENDAR_BORDERED_BUTTON} onClick={openSystemSettings}>
            {t('calendar.providers.appleEventKit.openSystemSettings')}
          </button>
        )}
        {onCheckAgain && (
          <button
            type="button"
            className={CALENDAR_QUIET_BUTTON}
            disabled={checking}
            onClick={onCheckAgain}
          >
            {t('calendar.providers.appleEventKit.checkAgain')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Before connecting: what this reads and where it stays, then the one button
 * that can show the macOS permission dialog. Nothing asks at launch.
 */
function MacosCalendarConnect({
  onConnected
}: {
  onConnected: () => Promise<void>
}): React.JSX.Element {
  const { t } = useT('settings')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const connect = useMutation({
    mutationFn: () => calendarService.connectProvider({ provider: 'apple-eventkit' }),
    onSuccess: async (result) => {
      if (result.success) {
        setErrorCode(null)
        await onConnected()
        return
      }
      setErrorCode(result.errorCode ?? 'sync_failed')
    },
    onError: () => setErrorCode('sync_failed')
  })

  return (
    <div className="flex flex-col gap-2" data-testid="macos-calendar-connect">
      <p className="text-xs/4 text-muted-foreground">
        {t('calendar.providers.appleEventKit.description')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={CALENDAR_BORDERED_BUTTON}
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
        >
          {connect.isPending
            ? t('calendar.providers.connecting')
            : t('calendar.providers.appleEventKit.connect')}
        </button>
        <span className="text-xs/4 text-muted-foreground">
          {t('calendar.providers.appleEventKit.connectHint')}
        </span>
      </div>
      {errorCode && (
        <PermissionProblem
          code={errorCode}
          checking={connect.isPending}
          onCheckAgain={() => connect.mutate()}
        />
      )}
    </div>
  )
}

/** While connected: a revoked or broken permission, with its fix. */
function MacosCalendarNotice({
  status
}: {
  status: CalendarProviderStatus
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const account = status.accounts[0]
  const recheck = useMutation({
    mutationFn: () => calendarService.refreshProvider({ provider: 'apple-eventkit' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['calendar', 'apple-eventkit'] })
  })
  if (!account || account.status === 'connected' || !account.lastError) return null
  return (
    <PermissionProblem
      code={account.lastError}
      checking={recheck.isPending}
      onCheckAgain={() => recheck.mutate()}
    />
  )
}

/**
 * Settings → Calendar → This Mac (#2374). macOS only: main lists this
 * provider only on darwin, so on Windows and Linux this never renders.
 * Calendars are grouped by the account Calendar.app files them under.
 */
export function MacosCalendarProviderPanel({
  provider,
  name
}: {
  provider: CalendarProviderDescriptor
  name?: string
}): React.JSX.Element {
  const { t } = useT('settings')

  const providerName = (id: string): string => {
    if (id === 'google') return t('calendar.google.name')
    if (id === 'caldav') return t('calendar.providers.caldav.name')
    return id
  }
  const metadataOf = (source: CalendarSourceRecord): Record<string, unknown> =>
    source.metadata ?? {}

  return (
    <GenericCalendarProviderPanel
      provider={provider}
      name={name ?? t('calendar.providers.appleEventKit.name')}
      tile={<Laptop className="size-3.5" />}
      renderConnectForm={({ onConnected }) => <MacosCalendarConnect onConnected={onConnected} />}
      renderConnectedNotice={(status) => <MacosCalendarNotice status={status} />}
      calendarGroupLabel={(source) => {
        const title = metadataOf(source).sourceTitle
        return typeof title === 'string' && title
          ? title
          : t('calendar.providers.appleEventKit.otherCalendars')
      }}
      calendarNote={(source) => {
        const via = metadataOf(source).connectedVia
        return typeof via === 'string'
          ? t('calendar.providers.appleEventKit.alreadyConnected', { provider: providerName(via) })
          : null
      }}
    />
  )
}
