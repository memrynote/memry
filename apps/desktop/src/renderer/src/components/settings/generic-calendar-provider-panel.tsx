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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { extractErrorMessage } from '@/lib/ipc-error'
import { calendarService } from '@/services/calendar-service'
import { ACCENT_SWITCH } from '@/components/settings/settings-primitives'
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
  renderConnectForm,
  describeReconnect,
  renderConnectedNotice,
  calendarGroupLabel,
  calendarNote
}: {
  provider: CalendarProviderDescriptor
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

  return (
    <div className="grid gap-3 px-4 py-3" data-testid={`calendar-provider-panel-${id}`}>
      <ProviderPanelHeader
        provider={provider}
        connected={connected}
        busy={busy}
        onRefresh={() => refreshMutation.mutate()}
        onToggleAddAccount={() => setShowConnectForm((open) => !open)}
        onDisconnect={() => disconnectMutation.mutate(undefined)}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(error, t('calendar.providers.refreshFailed'))}
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
        <ProviderPushRow
          providerId={id}
          enabled={pushEnabled}
          pending={pushMutation.isPending}
          onChange={(checked) => pushMutation.mutate(checked)}
        />
      )}

      {connected && capabilities.supportsWrite && <CalendarDefaultTargetRow providerId={id} />}

      {connected && (
        <div className="-mx-4 border-t border-border/60">
          <ProviderAgentAccessRow providerId={id} />
        </div>
      )}
    </div>
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
    <ul className="grid gap-2" aria-label={t('calendar.providers.accounts')}>
      {accounts.map((account) => (
        <li
          key={account.accountId}
          data-testid={`calendar-provider-account-${account.accountId}`}
          className="grid gap-1 rounded-md border border-border/70 px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium text-foreground">{account.email}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]/4"
              disabled={busy}
              onClick={() => onDisconnect(account.accountId)}
            >
              {t('calendar.providers.disconnect')}
            </Button>
          </div>
          {account.status === 'reconnect_required' && (
            <div
              className="grid gap-1.5"
              data-testid={`calendar-provider-reconnect-${account.accountId}`}
            >
              <p className="text-[11px]/4 text-amber-800 dark:text-amber-300">
                {describeReconnect?.(account) ?? t('calendar.providers.reconnectRequired')}
              </p>
              {renderConnectForm && reconnectAccountId !== account.accountId && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 w-fit px-2 text-[11px]/4"
                  onClick={() => onReconnect(account.accountId)}
                >
                  {t('calendar.providers.reconnect')}
                </Button>
              )}
              {renderConnectForm &&
                reconnectAccountId === account.accountId &&
                renderConnectForm({ onConnected, reconnect: account })}
            </div>
          )}
          {account.status === 'error' && account.lastError && (
            <p className="text-[11px]/4 text-destructive">{account.lastError}</p>
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
      <li key={source.id} className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label className="flex min-w-0 items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={source.isSelected}
              disabled={selectionPending}
              onCheckedChange={(checked) =>
                onSelect({ id: source.id, isSelected: checked === true })
              }
              aria-label={source.title}
            />
            <span className="truncate">{source.title}</span>
          </label>
          {hint && <p className="ps-6 text-[11px]/4 text-muted-foreground">{hint}</p>}
        </div>
        {source.syncStatus === 'error' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]/4"
            disabled={retryPending}
            onClick={() => onRetry(source.id)}
          >
            {t('calendar.providers.retry')}
          </Button>
        )}
      </li>
    )
  }

  if (!groupLabel) {
    return (
      <ul className="grid gap-1.5" aria-label={t('calendar.providers.calendars')}>
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
    <div className="grid gap-3" aria-label={t('calendar.providers.calendars')} role="group">
      {[...groups.entries()].map(([label, members]) => (
        <section key={label} className="grid gap-1.5" aria-label={label}>
          <h4 className="text-[11px]/4 font-medium text-muted-foreground">{label}</h4>
          <ul className="grid gap-1.5">{members.map(renderCalendar)}</ul>
        </section>
      ))}
    </div>
  )
}

/** Status and read-only badges, the refresh interval, and the account actions. */
function ProviderPanelHeader({
  provider,
  connected,
  busy,
  onRefresh,
  onToggleAddAccount,
  onDisconnect
}: {
  provider: CalendarProviderDescriptor
  connected: boolean
  busy: boolean
  onRefresh: () => void
  onToggleAddAccount: () => void
  onDisconnect: () => void
}): React.JSX.Element {
  const { t } = useT('settings')
  const { id, capabilities } = provider
  const pollMinutes = capabilities.pollIntervalMs
    ? Math.round(capabilities.pollIntervalMs / 60_000)
    : null
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="secondary"
            className="h-4 w-fit border-0 px-1.5 py-0 text-[10px]/3 text-foreground"
          >
            {connected
              ? t('calendar.providers.statuses.connected')
              : t('calendar.providers.statuses.notConnected')}
          </Badge>
          {!capabilities.supportsWrite && (
            <Badge
              variant="outline"
              className="h-4 w-fit px-1.5 py-0 text-[10px]/3"
              data-testid={`calendar-provider-read-only-${id}`}
            >
              {t('calendar.providers.readOnly')}
            </Badge>
          )}
        </div>
        {!capabilities.supportsPush && pollMinutes !== null && (
          <p
            className="text-xs/4 text-muted-foreground"
            data-testid={`calendar-provider-poll-${id}`}
          >
            {t('calendar.providers.pollInterval', { minutes: pollMinutes })}
          </p>
        )}
      </div>
      {connected && (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs/4"
            disabled={busy}
            onClick={onRefresh}
          >
            {t('calendar.providers.syncNow')}
          </Button>
          {capabilities.supportsMultiAccount && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs/4"
              data-testid={`calendar-provider-add-account-${id}`}
              onClick={onToggleAddAccount}
            >
              {t('calendar.providers.addAccount')}
            </Button>
          )}
          {!capabilities.supportsMultiAccount && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs/4"
              disabled={busy}
              onClick={onDisconnect}
            >
              {t('calendar.providers.disconnect')}
            </Button>
          )}
        </div>
      )}
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
    <Button
      variant="outline"
      size="sm"
      className="h-7 w-fit px-3 text-xs/4"
      onClick={() => {
        void calendarService.connectProvider({ provider: provider.id }).then(onConnected)
      }}
    >
      {t('calendar.providers.connect')}
    </Button>
  )
}

/** The one-way switch: whether Memry writes to this provider at all. */
function ProviderPushRow({
  providerId,
  enabled,
  pending,
  onChange
}: {
  providerId: string
  enabled: boolean
  pending: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px]/4 font-medium text-foreground">
          {t('calendar.providers.push.label')}
        </span>
        <p className="text-xs/4 text-muted-foreground">
          {t('calendar.providers.push.description')}
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={pending}
        onCheckedChange={onChange}
        aria-label={t('calendar.providers.push.label')}
        className={ACCENT_SWITCH}
        data-testid={`calendar-provider-push-${providerId}`}
      />
    </div>
  )
}
