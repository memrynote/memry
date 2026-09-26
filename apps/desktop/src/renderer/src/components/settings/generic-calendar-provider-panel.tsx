import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CalendarProviderAccountStatus,
  CalendarProviderDescriptor,
  CalendarProviderMutationResponse,
  CalendarProviderStatus,
  CalendarSourceRecord
} from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { calendarService } from '@/services/calendar-service'
import {
  CALENDAR_BORDERED_BUTTON,
  CALENDAR_DESTRUCTIVE_BUTTON,
  CALENDAR_QUIET_BUTTON,
  CalendarCheckRow,
  CalendarProviderRow,
  CalendarStatusLabel,
  CalendarSwitchRow
} from '@/components/settings/calendar-provider-row'
import {
  ProviderAgentAccessRow,
  providerSettingsQueryKey
} from '@/components/settings/calendar-provider-agent-access'
import { CalendarBasicConnectForm } from '@/components/settings/calendar-basic-connect-form'
import { CalendarDefaultTargetRow } from '@/components/settings/calendar-default-target-row'

function statusQueryKey(providerId: string): readonly string[] {
  return ['calendar', providerId, 'status'] as const
}

function sourcesQueryKey(providerId: string): readonly string[] {
  return ['calendar', providerId, 'sources'] as const
}

/**
 * The capability-driven settings panel for any provider without a bespoke
 * section (#1395). What it offers follows the provider's capabilities, never
 * its id:
 *
 * - `supportsWrite: false`: a Read-only badge and no push switch.
 * - `supportsMultiAccount`: an account list with "Add account"; otherwise one connection.
 * - `supportsPush: false`: the poll interval instead of a real-time claim.
 * - `authFlow`: which connect form appears.
 */
export interface ProviderConnectFormArgs {
  onConnected: () => Promise<void>
  /** Set when the form reconnects an account that needs its credential again. */
  reconnect?: CalendarProviderAccountStatus
}

function expectSuccess(result: CalendarProviderMutationResponse, fallback: string): void {
  if (!result.success) throw new Error(result.error ?? fallback)
}

export function GenericCalendarProviderPanel({
  provider,
  name = provider.id,
  tile,
  renderConnectForm,
  describeReconnect,
  renderConnectedNotice,
  calendarGroupLabel,
  calendarNote
}: {
  provider: CalendarProviderDescriptor
  name?: string
  /** The row's 28px tile; defaults to the name's first letter. */
  tile?: ReactNode
  /** A provider-specific connect form (CalDAV presets); defaults to the form for its auth flow. */
  renderConnectForm?: (args: ProviderConnectFormArgs) => ReactNode
  /** Copy for an account that needs reconnecting on this device. */
  describeReconnect?: (account: CalendarProviderAccountStatus) => string
  /** Shown under the header while connected (a single-account provider's state). */
  renderConnectedNotice?: (status: CalendarProviderStatus) => ReactNode
  /** Groups the calendar list under these headings, in first-seen order. */
  calendarGroupLabel?: (source: CalendarSourceRecord) => string
  /** A short muted line under one calendar. */
  calendarNote?: (source: CalendarSourceRecord) => string | null
}): React.JSX.Element {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const { id, capabilities } = provider
  const [showConnectForm, setShowConnectForm] = useState(false)
  const [reconnectAccountId, setReconnectAccountId] = useState<string | null>(null)

  const { data: status } = useQuery({
    queryKey: statusQueryKey(id),
    queryFn: () => calendarService.getProviderStatus({ provider: id })
  })
  const { data: sourcesData } = useQuery({
    queryKey: sourcesQueryKey(id),
    queryFn: () => calendarService.listSources({ provider: id, kind: 'calendar' })
  })
  const { data: settings } = useQuery({
    queryKey: providerSettingsQueryKey(id),
    queryFn: () => window.api.settings.getCalendarProviderSettings({ provider: id }),
    enabled: capabilities.supportsWrite
  })

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusQueryKey(id) }),
      queryClient.invalidateQueries({ queryKey: sourcesQueryKey(id) }),
      queryClient.invalidateQueries({ queryKey: ['calendar', 'sources'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
    ])
  }

  const disconnectMutation = useMutation({
    mutationFn: async (accountId?: string) => {
      const result = await calendarService.disconnectProvider({
        provider: id,
        ...(accountId ? { accountId } : {})
      })
      expectSuccess(result, t('calendar.providers.disconnectFailed'))
    },
    onSuccess: invalidate
  })
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await calendarService.refreshProvider({ provider: id })
      expectSuccess(result, t('calendar.providers.refreshFailed'))
    },
    onSettled: invalidate
  })
  const selectionMutation = useMutation({
    mutationFn: (input: { id: string; isSelected: boolean }) =>
      calendarService.updateSourceSelection(input),
    onSettled: invalidate
  })
  const retryMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      const result = await calendarService.retrySourceSync({ sourceId })
      if (!result.success) throw new Error(result.error ?? t('calendar.providers.refreshFailed'))
    },
    onSettled: invalidate
  })
  const pushMutation = useMutation({
    mutationFn: async (pushEventsToProvider: boolean) => {
      const result = await window.api.settings.setCalendarProviderSettings({
        provider: id,
        updates: { pushEventsToProvider }
      })
      if (!result.success) throw new Error(result.error)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: providerSettingsQueryKey(id) })
  })

  const connected = status?.connected === true
  const accounts = status?.accounts ?? []
  const calendars: CalendarSourceRecord[] = (sourcesData?.sources ?? []).filter(
    (source) => !source.isMemryManaged
  )
  const pushEnabled =
    (settings as { pushEventsToProvider?: boolean } | null | undefined)?.pushEventsToProvider !==
    false
  const error =
    disconnectMutation.error ?? refreshMutation.error ?? retryMutation.error ?? pushMutation.error
  const busy = disconnectMutation.isPending || refreshMutation.isPending
  const canAddAnother = capabilities.supportsMultiAccount || !connected
  const onConnected = async (): Promise<void> => {
    setShowConnectForm(false)
    setReconnectAccountId(null)
    await invalidate()
  }
  const connectForm = renderConnectForm ? (
    renderConnectForm({ onConnected })
  ) : (
    <DefaultConnectForm provider={provider} onConnected={onConnected} />
  )

  const needsAttention = accounts.some((account) => account.status !== 'connected')
  const selectedCount = calendars.filter((source) => source.isSelected).length
  const pollMinutes = capabilities.pollIntervalMs
    ? Math.round(capabilities.pollIntervalMs / 60_000)
    : null

  return (
    <CalendarProviderRow
      providerId={id}
      tile={tile ?? name.charAt(0).toUpperCase()}
      name={name}
      data-testid={`calendar-provider-panel-${id}`}
      defaultOpen={needsAttention}
      onConnectRequest={() => {
        if (connected && capabilities.supportsMultiAccount) setShowConnectForm(true)
      }}
      hint={
        <ProviderRowHint
          provider={provider}
          connected={connected}
          needsAttention={needsAttention}
          accounts={accounts}
        />
      }
      meta={
        connected && calendars.length > 0
          ? t('calendar.v2.calendarCount', { selected: selectedCount, count: calendars.length })
          : null
      }
      alert={
        error ? (
          <p role="alert" className="text-xs/4 text-destructive">
            {extractErrorMessage(error, t('calendar.providers.refreshFailed'))}
          </p>
        ) : null
      }
    >
      {!capabilities.supportsPush && pollMinutes !== null && (
        <p className="text-xs/4 text-muted-foreground" data-testid={`calendar-provider-poll-${id}`}>
          {t('calendar.providers.pollInterval', { minutes: pollMinutes })}
        </p>
      )}

      {(!connected || (showConnectForm && canAddAnother)) && connectForm}

      {connected && status && renderConnectedNotice?.(status)}

      {connected && capabilities.supportsMultiAccount && accounts.length > 0 && (
        <ProviderAccountList
          accounts={accounts}
          busy={busy}
          reconnectAccountId={reconnectAccountId}
          onDisconnect={(accountId) => disconnectMutation.mutate(accountId)}
          onReconnect={setReconnectAccountId}
          onConnected={onConnected}
          renderConnectForm={renderConnectForm}
          describeReconnect={describeReconnect}
        />
      )}

      {connected && calendars.length > 0 && (
        <ProviderCalendarList
          calendars={calendars}
          groupLabel={calendarGroupLabel}
          note={calendarNote}
          selectionPending={selectionMutation.isPending}
          retryPending={retryMutation.isPending}
          onSelect={(input) => selectionMutation.mutate(input)}
          onRetry={(sourceId) => retryMutation.mutate(sourceId)}
        />
      )}

      {connected && capabilities.supportsWrite && (
        <CalendarSwitchRow
          label={t('calendar.providers.push.label')}
          description={t('calendar.providers.push.description')}
          checked={pushEnabled}
          disabled={pushMutation.isPending}
          onCheckedChange={(checked) => pushMutation.mutate(checked)}
          data-testid={`calendar-provider-push-${id}`}
        />
      )}

      {connected && capabilities.supportsWrite && <CalendarDefaultTargetRow providerId={id} />}

      {connected && <ProviderAgentAccessRow providerId={id} />}

      {connected && (
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
          <button
            type="button"
            className={CALENDAR_QUIET_BUTTON}
            disabled={busy}
            onClick={() => refreshMutation.mutate()}
          >
            {t('calendar.providers.syncNow')}
          </button>
          {capabilities.supportsMultiAccount ? (
            <button
              type="button"
              className={CALENDAR_QUIET_BUTTON}
              data-testid={`calendar-provider-add-account-${id}`}
              onClick={() => setShowConnectForm((open) => !open)}
            >
              {t('calendar.providers.addAccount')}
            </button>
          ) : (
            <button
              type="button"
              className={CALENDAR_DESTRUCTIVE_BUTTON}
              disabled={busy}
              onClick={() => disconnectMutation.mutate(undefined)}
            >
              {t('calendar.providers.disconnect')}
            </button>
          )}
        </div>
      )}
    </CalendarProviderRow>
  )
}

/** Status, the connected account, and a Read-only mark, on one line. */
function ProviderRowHint({
  provider,
  connected,
  needsAttention,
  accounts
}: {
  provider: CalendarProviderDescriptor
  connected: boolean
  needsAttention: boolean
  accounts: CalendarProviderAccountStatus[]
}): React.JSX.Element {
  const { t } = useT('settings')
  const { id, capabilities } = provider
  const emails = accounts.map((account) => account.email).join(', ')
  return (
    <>
      <CalendarStatusLabel
        tone={connected ? (needsAttention ? 'warn' : 'ok') : 'off'}
        label={
          connected
            ? t('calendar.providers.statuses.connected')
            : t('calendar.providers.statuses.notConnected')
        }
      />
      {connected && emails && <span className="truncate">· {emails}</span>}
      {!capabilities.supportsWrite && (
        <span className="shrink-0" data-testid={`calendar-provider-read-only-${id}`}>
          · {t('calendar.providers.readOnly')}
        </span>
      )}
    </>
  )
}

/** Connected accounts, each with its disconnect and, when needed, reconnect. */
function ProviderAccountList({
  accounts,
  busy,
  reconnectAccountId,
  onDisconnect,
  onReconnect,
  onConnected,
  renderConnectForm,
  describeReconnect
}: {
  accounts: CalendarProviderAccountStatus[]
  busy: boolean
  reconnectAccountId: string | null
  onDisconnect: (accountId: string) => void
  onReconnect: (accountId: string) => void
  onConnected: () => Promise<void>
  renderConnectForm?: (args: ProviderConnectFormArgs) => ReactNode
  describeReconnect?: (account: CalendarProviderAccountStatus) => string
}): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <ul className="flex flex-col gap-1" aria-label={t('calendar.providers.accounts')}>
      {accounts.map((account) => (
        <li
          key={account.accountId}
          data-testid={`calendar-provider-account-${account.accountId}`}
          className="flex flex-col gap-1"
        >
          <div className="flex min-h-7 items-center justify-between gap-3">
            <span className="truncate text-xs/4 text-foreground">{account.email}</span>
            <button
              type="button"
              className={CALENDAR_DESTRUCTIVE_BUTTON}
              disabled={busy}
              onClick={() => onDisconnect(account.accountId)}
            >
              {t('calendar.providers.disconnect')}
            </button>
          </div>
          {account.status === 'reconnect_required' && (
            <div
              className="grid gap-1.5"
              data-testid={`calendar-provider-reconnect-${account.accountId}`}
            >
              <p className="text-xs/4 text-amber-800 dark:text-amber-300">
                {describeReconnect?.(account) ?? t('calendar.providers.reconnectRequired')}
              </p>
              {renderConnectForm && reconnectAccountId !== account.accountId && (
                <button
                  type="button"
                  className={`${CALENDAR_BORDERED_BUTTON} w-fit`}
                  onClick={() => onReconnect(account.accountId)}
                >
                  {t('calendar.providers.reconnect')}
                </button>
              )}
              {renderConnectForm &&
                reconnectAccountId === account.accountId &&
                renderConnectForm({ onConnected, reconnect: account })}
            </div>
          )}
          {account.status === 'error' && account.lastError && (
            <p className="text-xs/4 text-destructive">{account.lastError}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The provider's calendars: show or hide each, retry a failed one. */
function ProviderCalendarList({
  calendars,
  groupLabel,
  note,
  selectionPending,
  retryPending,
  onSelect,
  onRetry
}: {
  calendars: CalendarSourceRecord[]
  groupLabel?: (source: CalendarSourceRecord) => string
  note?: (source: CalendarSourceRecord) => string | null
  selectionPending: boolean
  retryPending: boolean
  onSelect: (input: { id: string; isSelected: boolean }) => void
  onRetry: (sourceId: string) => void
}): React.JSX.Element {
  const { t } = useT('settings')
  const renderCalendar = (source: CalendarSourceRecord): React.JSX.Element => {
    const hint = note?.(source) ?? null
    return (
      <li key={source.id}>
        <CalendarCheckRow
          title={source.title}
          color={source.color}
          checked={source.isSelected}
          disabled={selectionPending}
          onCheckedChange={(checked) => onSelect({ id: source.id, isSelected: checked })}
          trailing={
            source.syncStatus === 'error' ? (
              <button
                type="button"
                className={CALENDAR_QUIET_BUTTON}
                disabled={retryPending}
                onClick={() => onRetry(source.id)}
              >
                {t('calendar.providers.retry')}
              </button>
            ) : null
          }
        >
          {hint && <p className="text-[11px]/4 text-muted-foreground">{hint}</p>}
        </CalendarCheckRow>
      </li>
    )
  }

  if (!groupLabel) {
    return (
      <ul className="flex flex-col" aria-label={t('calendar.providers.calendars')}>
        {calendars.map(renderCalendar)}
      </ul>
    )
  }

  const groups = new Map<string, CalendarSourceRecord[]>()
  for (const source of calendars) {
    const label = groupLabel(source)
    groups.set(label, [...(groups.get(label) ?? []), source])
  }
  return (
    <div
      className="flex flex-col gap-3"
      aria-label={t('calendar.providers.calendars')}
      role="group"
    >
      {[...groups.entries()].map(([label, members]) => (
        <section key={label} className="flex flex-col gap-0.5" aria-label={label}>
          <h4 className="text-xs/4 text-muted-foreground">{label}</h4>
          <ul className="flex flex-col">{members.map(renderCalendar)}</ul>
        </section>
      ))}
    </div>
  )
}

/** The connect form for the provider's auth flow when it brings none of its own. */
function DefaultConnectForm({
  provider,
  onConnected
}: {
  provider: CalendarProviderDescriptor
  onConnected: () => Promise<void>
}): React.JSX.Element {
  const { t } = useT('settings')
  if (provider.capabilities.authFlow === 'basic') {
    return <CalendarBasicConnectForm provider={provider} onConnected={onConnected} />
  }
  return (
    <button
      type="button"
      className={`${CALENDAR_BORDERED_BUTTON} w-fit`}
      onClick={() => {
        void calendarService.connectProvider({ provider: provider.id }).then(onConnected)
      }}
    >
      {t('calendar.providers.connect')}
    </button>
  )
}
