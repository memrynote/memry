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
  const { presetName, errorMessage } = useCaldavCopy()
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
        connection: {
          ...connection,
          // A reconnect keeps the calendar choices the account already has.
          ...(reconnect ? {} : { selectedCalendarIds: [...selected] }),
          ...(acknowledged ? { acknowledgeOutdatedDevices: true } : {})
        }
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
      {!reconnect && (
        <label className="grid gap-1 text-xs text-foreground">
          <span>{t('calendar.caldav.presetLabel')}</span>
          <select
            value={presetId}
            onChange={(event) => {
              setPresetId(event.target.value as CaldavPresetId)
              setServerInput('')
              resetTest()
            }}
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
          onChange={(event) => {
            setServerInput(event.target.value)
            resetTest()
          }}
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
          onChange={(event) => {
            setUsername(event.target.value)
            resetTest()
          }}
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
        onChange={(event) => {
          setPassword(event.target.value)
          resetTest()
        }}
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

      {calendars && !reconnect && (
        <fieldset className="grid gap-1.5" data-testid="caldav-discovered-calendars">
          <legend className="pb-1 text-xs font-medium text-foreground">
            {t('calendar.caldav.chooseCalendars')}
          </legend>
          {calendars.map((calendar) => (
            <label key={calendar.id} className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={selected.has(calendar.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (checked === true) next.add(calendar.id)
                    else next.delete(calendar.id)
                    return next
                  })
                }
                aria-label={calendar.title}
              />
              <span className="truncate">{calendar.title}</span>
            </label>
          ))}
        </fieldset>
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

      <div className="flex items-center gap-2">
        {calendars ? (
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="h-7 w-fit px-3 text-xs/4"
            disabled={busy || needsAcknowledgement || (!reconnect && selected.size === 0)}
          >
            {busy ? t('calendar.providers.connecting') : t('calendar.providers.connect')}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="h-7 w-fit px-3 text-xs/4"
            disabled={busy || !detailsComplete}
          >
            {busy ? t('calendar.caldav.testing') : t('calendar.caldav.testConnection')}
          </Button>
        )}
      </div>
    </form>
  )
}
