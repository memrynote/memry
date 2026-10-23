/**
 * Readwise panel inside the import dialog (account-based importer, #1408 D1).
 * Not connected: a pasted access token, checked with Readwise before it is
 * stored (D2). Connected: root folder, folder layout, one switch per category,
 * cadence, Sync now and Disconnect. Disconnect deletes the token and keeps every
 * note (D9). The dialog owns the backfill; this panel reports "ready" upward so
 * the generic Import button can start it. No plan check anywhere: free plan
 * gets the whole integration.
 */

import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  READWISE_CADENCES,
  READWISE_CATEGORIES,
  type ReadwiseCadence,
  type ReadwiseCategory,
  type ReadwiseSetOptionsInput,
  type ReadwiseStatusResult
} from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  ACCENT_SWITCH,
  COMPACT_SELECT,
  SETTINGS_CARD,
  SETTINGS_GROUP_LABEL,
  SettingRow
} from '@/components/settings/settings-primitives'
import type { OneNotePanelState } from '@/components/settings/onenote-import-panel'
import {
  ReadwiseFirstImportPreview,
  type FirstImportState
} from '@/components/settings/readwise-first-import-preview'
import { ReadwiseDeletedBooks } from '@/components/settings/readwise-deleted-books'
import { ReadwiseTakeoverSection } from '@/components/settings/readwise-takeover-section'
import { ReadwiseLocationSection } from '@/components/settings/readwise-location-section'
import { ReadwiseJournalSection } from '@/components/settings/readwise-journal-section'
import { ReadwiseReaderSection } from '@/components/settings/readwise-reader-section'
import {
  ReadwiseReconnectForm,
  ReadwiseStatusBanner
} from '@/components/settings/readwise-status-banner'
import { extractErrorMessage, unwrapIpcResult as unwrap } from '@/lib/ipc-error'

const TOKEN_URL = 'https://readwise.io/access_token'

/** Routed to the OS browser by the main-process openExternal allowlist. */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

interface ReadwiseImportPanelProps {
  disabled: boolean
  /** Same handoff as OneNote's panel; Readwise has no per-run options, the engine reads the synced ones. */
  onStateChange: (state: OneNotePanelState) => void
}

export function ReadwiseImportPanel({ disabled, onStateChange }: ReadwiseImportPanelProps) {
  const { t } = useT('settings')
  const [status, setStatus] = useState<ReadwiseStatusResult | null>(null)
  const [token, setToken] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [firstImport, setFirstImport] = useState<FirstImportState>({
    ready: false,
    willImport: 0,
    documents: 0
  })
  const [reconnecting, setReconnecting] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.api.import.readwise
      .status()
      .then((raw) => {
        if (active) setStatus(unwrap(raw, t('import.dialog.error')))
      })
      .catch((err: unknown) => {
        if (active) setError(extractErrorMessage(err, t('import.dialog.error')))
      })
    return () => {
      active = false
    }
  }, [t, refreshNonce])

  // A run starting, moving on or ending changes the banner.
  useEffect(
    () =>
      window.api.onReadwiseStatusChanged(() => {
        setRefreshNonce((n) => n + 1)
      }),
    []
  )

  // Wrapped in queueMicrotask for the same reason as the OneNote panel: the
  // parent state update happens asynchronously.
  // The first import waits for its preview. Later runs need only the connection.
  const isFirstImport = Boolean(status?.connected && !status.hasImported)
  const ready = Boolean(status?.connected && (!isFirstImport || firstImport.ready))
  const confirmLabel = isFirstImport
    ? firstImport.willImport > 0
      ? t(
          firstImport.documents > 0
            ? 'import.dialog.readwise.importNotes'
            : 'import.dialog.readwise.importBooks',
          { count: firstImport.willImport }
        )
      : t('import.dialog.readwise.importNone')
    : undefined
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) onStateChange({ ready, options: {}, confirmLabel })
    })
    return () => {
      cancelled = true
    }
  }, [ready, confirmLabel, onStateChange])

  const connect = async (pasted: string = token) => {
    if (!pasted.trim() || isConnecting) return
    setIsConnecting(true)
    setTokenError(null)
    try {
      const result = unwrap(
        await window.api.import.readwise.connect({ token: pasted }),
        t('import.dialog.readwise.connectFailed')
      )
      if (!mountedRef.current) return
      setStatus(result)
      setToken('')
      setReconnecting(false)
    } catch (err) {
      if (mountedRef.current) {
        setTokenError(extractErrorMessage(err, t('import.dialog.readwise.connectFailed')))
      }
    } finally {
      if (mountedRef.current) setIsConnecting(false)
    }
  }

  const cancelSync = async () => {
    try {
      unwrap(await window.api.import.readwise.cancel(), t('import.dialog.error'))
    } catch (err) {
      if (mountedRef.current) setError(extractErrorMessage(err, t('import.dialog.error')))
    }
  }

  const disconnect = async () => {
    setError(null)
    try {
      unwrap(await window.api.import.readwise.disconnect(), t('import.dialog.error'))
      const next = unwrap(await window.api.import.readwise.status(), t('import.dialog.error'))
      if (mountedRef.current) setStatus(next)
    } catch (err) {
      if (mountedRef.current) setError(extractErrorMessage(err, t('import.dialog.error')))
    }
  }

  const syncNow = async () => {
    setIsSyncing(true)
    setError(null)
    try {
      unwrap(await window.api.import.readwise.syncNow(), t('import.dialog.error'))
      const next = unwrap(await window.api.import.readwise.status(), t('import.dialog.error'))
      if (mountedRef.current) setStatus(next)
    } catch (err) {
      if (mountedRef.current) setError(extractErrorMessage(err, t('import.dialog.error')))
    } finally {
      if (mountedRef.current) setIsSyncing(false)
    }
  }

  const setOptions = async (input: ReadwiseSetOptionsInput) => {
    setError(null)
    try {
      const next = unwrap(
        await window.api.import.readwise.setOptions(input),
        t('import.dialog.error')
      )
      if (mountedRef.current) setStatus(next)
    } catch (err) {
      if (mountedRef.current) setError(extractErrorMessage(err, t('import.dialog.error')))
    }
  }

  if (!status) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {error ? (
          <p className="text-xs/4 text-destructive">{error}</p>
        ) : (
          <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
            <Spinner />
          </div>
        )}
      </div>
    )
  }

  if (!status.thisDevicePulls) {
    return <ReadwiseTakeoverSection status={status} disabled={disabled} onTakenOver={setStatus} />
  }

  if (!status.connected) {
    return (
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
      >
        <p className="text-xs/4 text-muted-foreground">{t('import.dialog.readwise.intro')}</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="readwise-token" className="text-[13px]/4 text-foreground">
            {t('import.dialog.readwise.tokenLabel')}
          </label>
          <Input
            id="readwise-token"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            onChange={(event) => {
              setToken(event.target.value)
              setTokenError(null)
            }}
            placeholder={t('import.dialog.readwise.tokenPlaceholder')}
            aria-invalid={tokenError !== null}
            aria-describedby={tokenError ? 'readwise-token-error' : undefined}
            disabled={disabled || isConnecting}
            className="h-8 font-mono text-xs/4"
          />
          {tokenError && (
            <p id="readwise-token-error" role="alert" className="text-xs/4 text-destructive">
              {tokenError}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              openExternal(TOKEN_URL)
            }}
          >
            {t('import.dialog.readwise.getToken')}
          </Button>
          <Button type="submit" size="sm" disabled={disabled || isConnecting || !token.trim()}>
            {isConnecting
              ? t('import.dialog.readwise.connecting')
              : t('import.dialog.readwise.connect')}
          </Button>
        </div>
      </form>
    )
  }

  const { options } = status

  if (isFirstImport) {
    return (
      <ReadwiseFirstImportPreview
        options={options}
        disabled={disabled}
        onSetOptions={(input) => void setOptions(input)}
        onStateChange={setFirstImport}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="flex flex-col gap-3">
        <ReadwiseStatusBanner
          status={status}
          busy={isSyncing}
          onRetry={() => void syncNow()}
          onCancel={() => void cancelSync()}
          onPasteNew={() => {
            setReconnecting(true)
          }}
        />
        {reconnecting && (
          <ReadwiseReconnectForm
            error={tokenError}
            busy={isConnecting}
            disabled={disabled}
            onSubmit={(pasted) => void connect(pasted)}
            onCancel={() => {
              setReconnecting(false)
              setTokenError(null)
            }}
          />
        )}
      </section>

      <ReadwiseLocationSection
        options={options}
        disabled={disabled}
        onChange={(input) => void setOptions(input)}
      />

      <section className="flex flex-col">
        <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.categories')}</h4>
        <div className={SETTINGS_CARD}>
          {READWISE_CATEGORIES.map((category: ReadwiseCategory) => (
            <SettingRow
              key={category}
              label={t(`import.dialog.readwise.categories.${category}.label`)}
              description={t(`import.dialog.readwise.categories.${category}.description`)}
            >
              <Switch
                checked={options.categories[category]}
                onCheckedChange={(enabled) =>
                  void setOptions({ categories: { [category]: enabled } })
                }
                aria-label={t(`import.dialog.readwise.categories.${category}.label`)}
                className={ACCENT_SWITCH}
                disabled={disabled}
              />
            </SettingRow>
          ))}
        </div>
      </section>

      <ReadwiseReaderSection
        options={options}
        disabled={disabled}
        onChange={(input) => void setOptions(input)}
      />

      <ReadwiseJournalSection
        options={options}
        disabled={disabled}
        onChange={(input) => void setOptions(input)}
      />

      <section className="flex flex-col">
        <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.sync')}</h4>
        <div className={SETTINGS_CARD}>
          <SettingRow
            label={t('import.dialog.readwise.cadence.label')}
            description={t('import.dialog.readwise.cadence.description')}
          >
            <Select
              value={options.cadence}
              onValueChange={(value) => void setOptions({ cadence: value as ReadwiseCadence })}
              disabled={disabled}
            >
              <SelectTrigger
                aria-label={t('import.dialog.readwise.cadence.label')}
                className={COMPACT_SELECT}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {READWISE_CADENCES.map((cadence) => (
                  <SelectItem key={cadence} value={cadence} className="text-xs/4">
                    {t(`import.dialog.readwise.cadence.options.${cadence}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            label={t('import.dialog.readwise.syncNow.label')}
            description={t('import.dialog.readwise.syncNow.description')}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => void syncNow()}
              disabled={disabled || isSyncing || status.syncing !== null}
            >
              {t('import.dialog.readwise.syncNow.button')}
            </Button>
          </SettingRow>
        </div>
      </section>

      <ReadwiseDeletedBooks
        pullsHere={status.thisDevicePulls}
        pullingDeviceName={status.pullingDeviceName}
        disabled={disabled}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs/4 text-muted-foreground">
          {t('import.dialog.readwise.disconnectHint')}
        </p>
        <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={disabled}>
          {t('import.dialog.readwise.disconnect')}
        </Button>
      </div>

      {error && <p className="text-xs/4 text-destructive">{error}</p>}
    </div>
  )
}
