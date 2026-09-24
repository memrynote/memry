import { useState } from 'react'
import type {
  CalendarProviderDescriptor,
  CalendarWriterCompatResponse
} from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/ipc-error'
import { calendarService } from '@/services/calendar-service'

export interface CalendarBasicConnectFormProps {
  provider: CalendarProviderDescriptor
  onConnected: () => void | Promise<void>
  /** Prefills the server address, e.g. from a preset. */
  initialServerUrl?: string
  /** Hides the server field when a preset fixes it. */
  serverLocked?: boolean
  preset?: string
  /** Maps a connect `errorCode` to copy; unknown codes fall back to the generic message. */
  describeError?: (code: string) => string | null
}

/**
 * `authFlow: 'basic'` (#1395): server address, username and app password.
 *
 * Before a writable provider other than Google connects, this lists the
 * account's devices too old to share it (#1396) and requires an explicit
 * acknowledgement. Main refuses the connect without one, so this is the
 * explanation, not the enforcement.
 */
export function CalendarBasicConnectForm({
  provider,
  onConnected,
  initialServerUrl = '',
  serverLocked = false,
  preset,
  describeError
}: CalendarBasicConnectFormProps): React.JSX.Element {
  const { t } = useT('settings')
  const [serverUrl, setServerUrl] = useState(initialServerUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [compat, setCompat] = useState<CalendarWriterCompatResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const needsAcknowledgement =
    compat !== null &&
    compat.required &&
    (!compat.verified || compat.outdatedDevices.length > 0) &&
    !acknowledged

  const connect = async (): Promise<void> => {
    setIsConnecting(true)
    setError(null)
    try {
      if (provider.capabilities.supportsWrite && compat === null) {
        const checked = await calendarService.checkProviderWriterCompat({ provider: provider.id })
        setCompat(checked)
        if (checked.required && (!checked.verified || checked.outdatedDevices.length > 0)) {
          return
        }
      }
      const result = await calendarService.connectProvider({
        provider: provider.id,
        connection: {
          kind: 'basic',
          serverUrl: serverUrl.trim(),
          username: username.trim(),
          password,
          ...(preset ? { preset } : {}),
          ...(acknowledged ? { acknowledgeOutdatedDevices: true } : {})
        }
      })
      if (!result.success) {
        const described = result.errorCode ? describeError?.(result.errorCode) : null
        throw new Error(described ?? result.error ?? t('calendar.providers.connectFailed'))
      }
      setPassword('')
      await onConnected()
    } catch (cause) {
      setError(extractErrorMessage(cause, t('calendar.providers.connectFailed')))
    } finally {
      setIsConnecting(false)
    }
  }

  const canSubmit =
    serverUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    password.length > 0 &&
    !isConnecting &&
    !needsAcknowledgement

  return (
    <form
      className="grid gap-2"
      data-testid={`calendar-basic-connect-${provider.id}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) void connect()
      }}
    >
      {!serverLocked && (
        <Input
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder={t('calendar.providers.basic.serverPlaceholder')}
          aria-label={t('calendar.providers.basic.serverLabel')}
          spellCheck={false}
          autoComplete="url"
        />
      )}
      <Input
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        placeholder={t('calendar.providers.basic.usernameLabel')}
        aria-label={t('calendar.providers.basic.usernameLabel')}
        spellCheck={false}
        autoComplete="username"
      />
      <Input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={t('calendar.providers.basic.passwordLabel')}
        aria-label={t('calendar.providers.basic.passwordLabel')}
        autoComplete="current-password"
      />

      {compat && compat.required && (!compat.verified || compat.outdatedDevices.length > 0) && (
        <div
          role="alert"
          className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs/4 text-foreground"
          data-testid="calendar-writer-compat-warning"
        >
          <p>
            {compat.verified
              ? t('calendar.providers.compat.outdated', { version: compat.minVersion })
              : t('calendar.providers.compat.unverified')}
          </p>
          {compat.outdatedDevices.length > 0 && (
            <ul className="list-disc ps-4">
              {compat.outdatedDevices.map((device) => (
                <li key={device.id}>
                  {device.name}
                  {' · '}
                  {device.appVersion ?? t('calendar.providers.compat.unknownVersion')}
                </li>
              ))}
            </ul>
          )}
          <p>{t('calendar.providers.compat.consequence')}</p>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
              aria-label={t('calendar.providers.compat.acknowledge')}
            />
            <span>{t('calendar.providers.compat.acknowledge')}</span>
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="h-7 w-fit px-3 text-xs/4"
        disabled={!canSubmit}
      >
        {isConnecting ? t('calendar.providers.connecting') : t('calendar.providers.connect')}
      </Button>
    </form>
  )
}
