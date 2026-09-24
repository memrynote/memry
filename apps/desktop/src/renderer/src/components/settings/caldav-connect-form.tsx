import { useState } from 'react'
import {
  CALDAV_PRESETS,
  caldavPreset,
  caldavPresetServerUrl,
  type CaldavPresetId
} from '@memry/contracts/caldav-presets'
import type {
  CalendarProviderDescriptor,
  CalendarWriterCompatResponse,
  DiscoveredProviderCalendar
} from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/ipc-error'
import { calendarService } from '@/services/calendar-service'
import {
  CalendarWriterCompatNotice,
  writerCompatNeedsAcknowledgement
} from '@/components/settings/calendar-writer-compat-notice'

export interface CaldavReconnectTarget {
  serverUrl: string
  username: string
  preset: string | null
}

export interface CaldavConnectFormProps {
  provider: CalendarProviderDescriptor
  onConnected: () => void | Promise<void>
  /** Reconnecting an existing account: server and username are fixed. */
  reconnect?: CaldavReconnectTarget
}

function useCaldavCopy(): {
  presetName: (id: CaldavPresetId) => string
  errorMessage: (code: string, presetId: string | null) => string
} {
  const { t } = useT('settings')
  const presetName = (id: CaldavPresetId): string => {
    switch (id) {
      case 'icloud':
        return t('calendar.caldav.presets.icloud')
      case 'fastmail':
        return t('calendar.caldav.presets.fastmail')
      case 'nextcloud':
        return t('calendar.caldav.presets.nextcloud')
      case 'self-hosted':
        return t('calendar.caldav.presets.selfHosted')
      case 'zoho':
        return t('calendar.caldav.presets.zoho')
      case 'yahoo':
        return t('calendar.caldav.presets.yahoo')
      case 'mailbox-org':
        return t('calendar.caldav.presets.mailboxOrg')
      case 'posteo':
        return t('calendar.caldav.presets.posteo')
      case 'synology':
        return t('calendar.caldav.presets.synology')
      case 'other':
        return t('calendar.caldav.presets.other')
    }
  }
  const errorMessage = (code: string, presetId: string | null): string => {
    switch (code) {
      case 'unauthorized':
        // An iCloud 401 with a password the user believes is right is almost
        // always the Apple ID password used where an app-specific one belongs.
        return presetId === 'icloud'
          ? t('calendar.caldav.errors.unauthorizedIcloud')
          : t('calendar.caldav.errors.unauthorized')
      case 'unreachable':
        return t('calendar.caldav.errors.unreachable')
      case 'not_caldav':
        return t('calendar.caldav.errors.notCaldav')
      case 'no_calendars':
        return t('calendar.caldav.errors.noCalendars')
      case 'invalid_url':
        return t('calendar.caldav.errors.invalidUrl')
      case 'outdated_devices':
        return t('calendar.caldav.errors.outdatedDevices')
      default:
        return t('calendar.caldav.errors.unknown', { code })
    }
  }
  return { presetName, errorMessage }
}

/**
 * What `connectProvider` receives. A reconnect keeps the calendar choices the
 * account already has, so it sends none.
 */
function connectPayload<T extends object>(
  connection: T,
  options: { reconnecting: boolean; selected: Set<string>; acknowledged: boolean }
): T & { selectedCalendarIds?: string[]; acknowledgeOutdatedDevices?: boolean } {
  const payload: T & { selectedCalendarIds?: string[]; acknowledgeOutdatedDevices?: boolean } = {
    ...connection
  }
  if (!options.reconnecting) payload.selectedCalendarIds = [...options.selected]
  if (options.acknowledged) payload.acknowledgeOutdatedDevices = true
  return payload
}

/** "Test connection" until a test worked, then "Connect". */
function CaldavSubmitButton({
  tested,
  busy,
  disabled
}: {
  tested: boolean
  busy: boolean
  disabled: boolean
}): React.JSX.Element {
  const { t } = useT('settings')
  const idle = tested ? t('calendar.providers.connect') : t('calendar.caldav.testConnection')
  const working = tested ? t('calendar.providers.connecting') : t('calendar.caldav.testing')
  return (
    <div className="flex items-center gap-2">
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="h-7 w-fit px-3 text-xs/4"
        disabled={busy || disabled}
      >
        {busy ? working : idle}
      </Button>
    </div>
  )
}

/**
 * Connect a CalDAV account (#1401): pick a preset or type a server, enter the
 * username and app password, test the connection, choose calendars, connect.
 * Nothing is saved until the test worked, as with subscribed calendars.
 */
export function CaldavConnectForm({
  provider,
  onConnected,
  reconnect
}: CaldavConnectFormProps): React.JSX.Element {
  const { t } = useT('settings')
  const { errorMessage } = useCaldavCopy()
  const [presetId, setPresetId] = useState<CaldavPresetId>(
    caldavPreset(reconnect?.preset)?.id ?? (reconnect ? 'other' : 'icloud')
  )
  const [serverInput, setServerInput] = useState(reconnect?.serverUrl ?? '')
  const [username, setUsername] = useState(reconnect?.username ?? '')
  const [password, setPassword] = useState('')
  const [calendars, setCalendars] = useState<DiscoveredProviderCalendar[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [compat, setCompat] = useState<CalendarWriterCompatResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const preset = caldavPreset(presetId) ?? CALDAV_PRESETS[0]
  const serverUrl = reconnect ? reconnect.serverUrl : caldavPresetServerUrl(preset, serverInput)
  const connection = {
    kind: 'basic' as const,
    serverUrl,
    username: username.trim(),
    password,
    preset: presetId
  }
  const detailsComplete = serverUrl.length > 0 && username.trim().length > 0 && password.length > 0

  const resetTest = (): void => {
    setCalendars(null)
    setError(null)
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await calendarService.discoverProviderCalendars({
        provider: provider.id,
        connection
      })
      if (!result.success) {
        setError(errorMessage(result.errorCode ?? 'unknown', presetId))
        return
      }
      setCalendars(result.calendars)
      setSelected(new Set(result.calendars.map((calendar) => calendar.id)))
    } catch (cause) {
      setError(extractErrorMessage(cause, t('calendar.providers.connectFailed')))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (provider.capabilities.supportsWrite && compat === null) {
        const checked = await calendarService.checkProviderWriterCompat({ provider: provider.id })
        setCompat(checked)
        if (writerCompatNeedsAcknowledgement(checked)) return
      }
      const result = await calendarService.connectProvider({
        provider: provider.id,
        connection: connectPayload(connection, {
          reconnecting: Boolean(reconnect),
          selected,
          acknowledged
        })
      })
      if (!result.success) {
        setError(errorMessage(result.errorCode ?? 'unknown', presetId))
        return
      }
      setPassword('')
      await onConnected()
    } catch (cause) {
      setError(extractErrorMessage(cause, t('calendar.providers.connectFailed')))
    } finally {
      setBusy(false)
    }
  }

  const needsAcknowledgement = writerCompatNeedsAcknowledgement(compat) && !acknowledged

  return (
    <form
      className="grid gap-2"
      data-testid={`caldav-connect-form${reconnect ? '-reconnect' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !detailsComplete) return
        void (calendars ? connect() : testConnection())
      }}
    >
      <CaldavAccountFields
        presetId={presetId}
        serverInput={serverInput}
        username={username}
        password={password}
        reconnect={reconnect}
        onPresetChange={(next) => {
          setPresetId(next)
          setServerInput('')
          resetTest()
        }}
        onServerInputChange={(next) => {
          setServerInput(next)
          resetTest()
        }}
        onUsernameChange={(next) => {
          setUsername(next)
          resetTest()
        }}
        onCredentialChange={(next) => {
          setPassword(next)
          resetTest()
        }}
      />

      {calendars && !reconnect && (
        <CaldavCalendarChoice calendars={calendars} selected={selected} onChange={setSelected} />
      )}

      {compat && writerCompatNeedsAcknowledgement(compat) && (
        <CalendarWriterCompatNotice
          compat={compat}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive" data-testid="caldav-connect-error">
          {error}
        </p>
      )}

      <CaldavSubmitButton
        tested={calendars !== null}
        busy={busy}
        disabled={
          calendars ? needsAcknowledgement || (!reconnect && selected.size === 0) : !detailsComplete
        }
      />
    </form>
  )
}

interface CaldavAccountFieldsProps {
  presetId: CaldavPresetId
  serverInput: string
  username: string
  password: string
  reconnect?: CaldavReconnectTarget
  onPresetChange: (presetId: CaldavPresetId) => void
  onServerInputChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onCredentialChange: (value: string) => void
}

/** Preset, server, username and app password, with the preset's help text. */
function CaldavAccountFields({
  presetId,
  serverInput,
  username,
  password,
  reconnect,
  onPresetChange,
  onServerInputChange,
  onUsernameChange,
  onCredentialChange
}: CaldavAccountFieldsProps): React.JSX.Element {
  const { t } = useT('settings')
  const { presetName } = useCaldavCopy()
  const preset = caldavPreset(presetId) ?? CALDAV_PRESETS[0]
  return (
    <>
      {!reconnect && (
        <label className="grid gap-1 text-xs text-foreground">
          <span>{t('calendar.caldav.presetLabel')}</span>
          <select
            value={presetId}
            onChange={(event) => onPresetChange(event.target.value as CaldavPresetId)}
            aria-label={t('calendar.caldav.presetLabel')}
            className="h-[30px] rounded-[7px] border border-input bg-transparent px-2 text-xs"
          >
            {CALDAV_PRESETS.map((option) => (
              <option key={option.id} value={option.id}>
                {presetName(option.id)}
              </option>
            ))}
          </select>
        </label>
      )}

      {!reconnect && !preset.serverUrl && (
        <Input
          value={serverInput}
          onChange={(event) => onServerInputChange(event.target.value)}
          placeholder={
            preset.hostTemplate
              ? t('calendar.caldav.hostPlaceholder')
              : t('calendar.providers.basic.serverPlaceholder')
          }
          aria-label={
            preset.hostTemplate
              ? t('calendar.caldav.hostLabel')
              : t('calendar.providers.basic.serverLabel')
          }
          spellCheck={false}
          autoComplete="url"
        />
      )}

      {reconnect ? (
        <p className="text-xs/4 text-muted-foreground" data-testid="caldav-reconnect-account">
          {t('calendar.caldav.reconnectFor', { username: reconnect.username })}
        </p>
      ) : (
        <Input
          value={username}
          onChange={(event) => onUsernameChange(event.target.value)}
          placeholder={
            presetId === 'icloud'
              ? t('calendar.caldav.appleIdLabel')
              : t('calendar.providers.basic.usernameLabel')
          }
          aria-label={t('calendar.providers.basic.usernameLabel')}
          spellCheck={false}
          autoComplete="username"
        />
      )}
      <Input
        type="password"
        value={password}
        onChange={(event) => onCredentialChange(event.target.value)}
        placeholder={t('calendar.providers.basic.passwordLabel')}
        aria-label={t('calendar.providers.basic.passwordLabel')}
        autoComplete="current-password"
      />
      <p className="text-[11px]/4 text-muted-foreground">
        {presetId === 'icloud'
          ? t('calendar.caldav.icloudHelp')
          : t('calendar.caldav.appPasswordHelp')}{' '}
        {preset.appAccessHelpUrl && (
          <a
            href={preset.appAccessHelpUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {t('calendar.caldav.createAppPassword')}
          </a>
        )}
      </p>
    </>
  )
}

/** The calendars a tested connection found; the user picks which to show. */
function CaldavCalendarChoice({
  calendars,
  selected,
  onChange
}: {
  calendars: DiscoveredProviderCalendar[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <fieldset className="grid gap-1.5" data-testid="caldav-discovered-calendars">
      <legend className="pb-1 text-xs font-medium text-foreground">
        {t('calendar.caldav.chooseCalendars')}
      </legend>
      {calendars.map((calendar) => (
        <label key={calendar.id} className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={selected.has(calendar.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected)
              if (checked === true) next.add(calendar.id)
              else next.delete(calendar.id)
              onChange(next)
            }}
            aria-label={calendar.title}
          />
          <span className="truncate">{calendar.title}</span>
        </label>
      ))}
    </fieldset>
  )
}
