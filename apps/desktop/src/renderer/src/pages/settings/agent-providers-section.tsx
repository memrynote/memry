import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentAccessMode,
  AgentBackendStatus,
  AgentCliBackendId,
  AgentLocalProviderPreset,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings,
  AgentPreferences,
  AgentToolApprovalMode,
  BackendStatusesResponse
} from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  ACCENT_SWITCH,
  SettingsGroup,
  SettingsHeader,
  SettingRow
} from '@/components/settings/settings-primitives'
import { ChevronRight } from '@/lib/icons'
import { trackTelemetry } from '@/lib/telemetry'
import { cn } from '@/lib/utils'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** One row per CLI backend; the rows differ only in their labels. */
const CLI_AGENT_ROWS: Array<{ backend: AgentCliBackendId; key: string }> = [
  { backend: 'claude_cli', key: 'claude' },
  { backend: 'codex_cli', key: 'codex' },
  { backend: 'antigravity_cli', key: 'antigravity' }
]

function cliStatusText(cli: AgentBackendStatus | undefined, t: Translate): string {
  if (!cli) return t('agentProviders.cliAgents.status.notDetected')
  // The agent runtime is down for the whole session (vault key unavailable);
  // the CLI was never probed, so "Not detected" would be a guess \u2014 and a wrong
  // one whenever the CLI is in fact installed.
  if (cli.reason === 'agent_unavailable') {
    return t('agentProviders.cliAgents.status.runtimeUnavailable')
  }
  if (cli.available) {
    return cli.version
      ? t('agentProviders.cliAgents.status.detected', { version: cli.version })
      : t('agentProviders.cliAgents.status.detectedNoVersion')
  }
  if (cli.version && cli.minimumRequired) {
    return t('agentProviders.cliAgents.status.belowMinimum', {
      version: cli.version,
      minimum: cli.minimumRequired
    })
  }
  return t('agentProviders.cliAgents.status.notDetected')
}

const PRESET_DEFAULTS: Record<Exclude<AgentLocalProviderPreset, 'custom'>, string> = {
  ollama: 'http://localhost:11434/v1',
  lm_studio: 'http://localhost:1234/v1',
  llama_cpp: 'http://127.0.0.1:8080/v1'
}

export function AgentProvidersSection({
  embedded = false
}: {
  embedded?: boolean
}): React.JSX.Element | null {
  const { t } = useT('settings')
  const [settings, setSettings] = useState<AgentLocalProviderSettings | null>(null)
  const [preferences, setPreferences] = useState<AgentPreferences | null>(null)
  const [backendStatuses, setBackendStatuses] = useState<BackendStatusesResponse | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<AgentLocalProviderProbeResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [alwaysAllowed, setAlwaysAllowed] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.agent.getLocalProviderSettings(),
      window.api.agent.getPreferences()
    ]).then(([nextSettings, nextPreferences]) => {
      if (cancelled) return
      setSettings(nextSettings)
      setPreferences(nextPreferences)
    })
    void window.api.agent.getBackendStatuses().then((statuses) => {
      if (!cancelled) setBackendStatuses(statuses)
    })
    // A standing approval the user cannot find is a standing approval they
    // cannot take back, so this list is not optional chrome.
    void window.api.agent
      .getToolGrants()
      .then((grants) => {
        if (!cancelled) setAlwaysAllowed(grants.tools)
      })
      .catch(() => {
        // The agent runtime starts lazily; an empty list is the honest state
        // until it answers, and the next visit to this page re-reads it.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-save edits (debounced), then re-check the connection and surface any error inline.
  useEffect(() => {
    if (!dirty || !settings) return
    const handle = setTimeout(() => {
      void (async () => {
        setBusy('save')
        try {
          const saved = await window.api.agent.setLocalProviderSettings({
            preset: settings.preset,
            baseUrl: settings.baseUrl,
            model: settings.model,
            allowNonLoopback: settings.allowNonLoopback,
            apiKey: apiKey || undefined
          })
          setSettings(saved)
          setDirty(false)
          setStatus(await window.api.agent.testLocalProvider())
        } finally {
          setBusy(null)
        }
      })()
    }, 600)
    return () => clearTimeout(handle)
  }, [dirty, settings, apiKey])

  const nonLoopback = useMemo(() => {
    if (!settings) return false
    try {
      const host = new URL(settings.baseUrl).hostname
      return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
    } catch {
      return false
    }
  }, [settings])

  const updateSetting = useCallback(
    <K extends keyof AgentLocalProviderSettings>(key: K, value: AgentLocalProviderSettings[K]) => {
      setSettings((current) => (current ? { ...current, [key]: value } : current))
      setDirty(true)
    },
    []
  )

  const changePreset = useCallback((preset: AgentLocalProviderPreset) => {
    setSettings((current) => {
      if (!current) return current
      const baseUrl = preset === 'custom' ? current.baseUrl : PRESET_DEFAULTS[preset]
      return { ...current, preset, baseUrl }
    })
    setDirty(true)
    void trackTelemetry('setting_changed', {
      surface: 'settings',
      action: 'changed',
      objectType: 'agent_local_provider_preset',
      dimensions: { value: preset }
    })
  }, [])

  const updateApiKey = useCallback((value: string) => {
    setApiKey(value)
    setDirty(true)
  }, [])

  const changeToolApprovalMode = useCallback(async (toolApprovalMode: AgentToolApprovalMode) => {
    setPreferences((current) => (current ? { ...current, toolApprovalMode } : current))
    const saved = await window.api.agent.setPreferences({ toolApprovalMode })
    setPreferences(saved)
    // Security-relevant preference: enum value only, never free text.
    void trackTelemetry('setting_changed', {
      surface: 'settings',
      action: 'changed',
      objectType: 'agent_tool_approval_mode',
      dimensions: { value: toolApprovalMode }
    })
  }, [])

  const revokeAlwaysAllowed = useCallback(async (toolName: string) => {
    await window.api.agent.editTrustList({ remove: [toolName], scope: 'vault' })
    const grants = await window.api.agent.getToolGrants()
    setAlwaysAllowed(grants.tools)
    void trackTelemetry('setting_changed', {
      surface: 'settings',
      action: 'changed',
      objectType: 'agent_tool_grant_revoked'
    })
  }, [])

  const changeAccessMode = useCallback(async (accessMode: AgentAccessMode) => {
    setPreferences((current) => (current ? { ...current, accessMode } : current))
    const saved = await window.api.agent.setPreferences({ accessMode })
    setPreferences(saved)
    void trackTelemetry('setting_changed', {
      surface: 'settings',
      action: 'changed',
      objectType: 'agent_access_mode',
      dimensions: { value: accessMode }
    })
  }, [])

  const loadModels = useCallback(async () => {
    setBusy('models')
    try {
      const result = await window.api.agent.listLocalModels()
      setModels(result.models)
    } finally {
      setBusy(null)
    }
  }, [])

  const testConnection = useCallback(async () => {
    setBusy('test')
    try {
      setStatus(await window.api.agent.testLocalProvider())
    } finally {
      setBusy(null)
    }
  }, [])

  const connectionError =
    status && (!status.connected || !status.modelAvailable) ? status.detail : null

  if (!settings || !preferences) return null

  const localStatus: { tone: StatusTone; text: string } =
    busy === 'save' || busy === 'test'
      ? { tone: 'pending', text: t('agentProviders.status.checking') }
      : connectionError
        ? { tone: 'warning', text: t('agentProviders.status.disconnected') }
        : status
          ? { tone: 'ready', text: t('agentProviders.status.connected') }
          : { tone: 'off', text: t('agentProviders.v2.localModel.notChecked') }

  return (
    <div>
      {!embedded && (
        <SettingsHeader
          title={t('agentProviders.header.title')}
          subtitle={t('agentProviders.header.subtitle')}
        />
      )}

      <GroupHeading
        label={t('agentProviders.v2.permissions.group')}
        hint={t('agentProviders.v2.permissions.hint')}
      />
      <SettingsGroup>
        <SettingRow
          label={t('agentProviders.v2.permissions.access')}
          description={t('agentProviders.permissions.access.description')}
        >
          <SegmentedControl<AgentAccessMode>
            label={t('agentProviders.v2.permissions.access')}
            value={preferences.accessMode}
            onChange={(value) => void changeAccessMode(value)}
            options={[
              { value: 'vault_only', label: t('agentProviders.permissions.access.vaultOnly') },
              {
                value: 'computer_access',
                label: t('agentProviders.permissions.access.computerAccess')
              }
            ]}
          />
        </SettingRow>
        <SettingRow
          label={t('agentProviders.v2.permissions.changes')}
          description={t('agentProviders.permissions.confirm.description')}
        >
          <SegmentedControl<AgentToolApprovalMode>
            label={t('agentProviders.v2.permissions.changes')}
            value={preferences.toolApprovalMode}
            onChange={(value) => void changeToolApprovalMode(value)}
            options={[
              { value: 'ask', label: t('agentProviders.permissions.confirm.askBeforeChanges') },
              {
                value: 'always_accept',
                label: t('agentProviders.permissions.confirm.alwaysAllow')
              }
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <GroupHeading
        label={t('agentProviders.v2.runtimes.group')}
        hint={t('agentProviders.v2.runtimes.hint')}
      />
      <SettingsGroup>
        {CLI_AGENT_ROWS.map((row) => {
          const cli = backendStatuses?.[row.backend]
          const tone = cliStatusTone(cli)
          const statusText = cliStatusText(cli, t)
          return (
            <div
              key={row.backend}
              className="flex min-h-11 items-center justify-between gap-4 py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <StatusDot tone={tone} />
                  <span className="text-[13px]/4 text-foreground">
                    {t(`agentProviders.cliAgents.${row.key}.label`)}
                  </span>
                </div>
                {tone === 'off' && (
                  <span className="ps-3.5 text-xs/4 text-muted-foreground">
                    {t(`agentProviders.cliAgents.${row.key}.description`)}
                  </span>
                )}
              </div>
              <span
                title={statusText}
                className={cn('w-56 shrink-0 truncate text-end text-xs/4', STATUS_TEXT_CLASS[tone])}
              >
                {statusText}
              </span>
            </div>
          )
        })}
        <Collapsible>
          <CollapsibleTrigger className="group flex min-h-14 w-full items-center justify-between gap-4 rounded-sm py-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <StatusDot tone={localStatus.tone} />
                <span className="text-[13px]/4 text-foreground">
                  {t('agentProviders.v2.localModel.label')}
                </span>
              </div>
              <span className="ps-3.5 text-xs/4 text-muted-foreground">
                {t('agentProviders.v2.localModel.hint')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={cn('text-xs/4', STATUS_TEXT_CLASS[localStatus.tone])}>
                {localStatus.text}
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 rtl:rotate-180 rtl:group-data-[state=open]:rotate-90" />
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col pb-2 ps-3.5">
              <FieldRow label={t('agentProviders.fields.preset.label')}>
                <SegmentedControl<AgentLocalProviderPreset>
                  label={t('agentProviders.fields.preset.label')}
                  value={settings.preset}
                  onChange={changePreset}
                  options={[
                    { value: 'ollama', label: t('agentProviders.presets.ollama') },
                    { value: 'lm_studio', label: t('agentProviders.presets.lmStudio') },
                    { value: 'llama_cpp', label: t('agentProviders.presets.llamaCpp') },
                    { value: 'custom', label: t('agentProviders.presets.custom') }
                  ]}
                />
              </FieldRow>
              <FieldRow
                label={t('agentProviders.fields.baseUrl.label')}
                hint={t('agentProviders.fields.baseUrl.description')}
              >
                <Input
                  aria-label={t('agentProviders.fields.baseUrl.label')}
                  value={settings.baseUrl}
                  onChange={(event) => updateSetting('baseUrl', event.target.value)}
                  className="h-7 w-64 font-mono text-xs"
                />
              </FieldRow>
              {nonLoopback && (
                <FieldRow
                  label={t('agentProviders.fields.allowNonLoopback.label')}
                  hint={t('agentProviders.fields.allowNonLoopback.description')}
                >
                  <Switch
                    aria-label={t('agentProviders.fields.allowNonLoopback.label')}
                    checked={settings.allowNonLoopback}
                    onCheckedChange={(checked) => updateSetting('allowNonLoopback', checked)}
                    className={ACCENT_SWITCH}
                  />
                </FieldRow>
              )}
              <FieldRow
                label={t('agentProviders.fields.model.label')}
                hint={t('agentProviders.fields.model.description')}
              >
                <button
                  type="button"
                  className={QUIET_ACTION}
                  onClick={() => void loadModels()}
                  disabled={busy === 'models'}
                >
                  {t('agentProviders.v2.localModel.fetchModels')}
                </button>
                <Input
                  aria-label={t('agentProviders.fields.model.label')}
                  value={settings.model}
                  onChange={(event) => updateSetting('model', event.target.value)}
                  className="h-7 w-48 font-mono text-xs"
                />
              </FieldRow>
              {models.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1 pb-2">
                  {models.map((model) => (
                    <button
                      key={model}
                      type="button"
                      onClick={() => updateSetting('model', model)}
                      className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs/4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
              <FieldRow
                label={t('agentProviders.fields.apiKey.label')}
                hint={
                  settings.apiKeyConfigured
                    ? t('agentProviders.fields.apiKey.configured')
                    : t('agentProviders.fields.apiKey.description')
                }
              >
                <Input
                  aria-label={t('agentProviders.fields.apiKey.label')}
                  value={apiKey}
                  type="password"
                  placeholder={t('agentProviders.v2.localModel.optional')}
                  onChange={(event) => updateApiKey(event.target.value)}
                  className="h-7 w-48 font-mono text-xs"
                />
              </FieldRow>
              <FieldRow label={t('agentProviders.status.label')}>
                {busy === 'save' || busy === 'test' ? (
                  <span className="text-xs/4 text-muted-foreground">
                    {t('agentProviders.status.checking')}
                  </span>
                ) : connectionError ? (
                  <span
                    className="max-w-60 truncate text-xs/4 text-destructive"
                    title={connectionError}
                  >
                    {connectionError}
                  </span>
                ) : status ? (
                  <span className="text-xs/4 text-green-600">
                    {t('agentProviders.status.connected')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={QUIET_ACTION}
                  onClick={() => void testConnection()}
                  disabled={busy !== null}
                >
                  {t('agentProviders.actions.test')}
                </button>
              </FieldRow>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </SettingsGroup>

      <GroupHeading
        label={t('agentProviders.v2.alwaysAllowed.group')}
        hint={t('agentProviders.alwaysAllowed.description')}
      />
      <SettingsGroup>
        {alwaysAllowed.length === 0 ? (
          <div className="flex min-h-11 items-center py-2.5 text-xs/4 text-muted-foreground">
            {t('agentProviders.alwaysAllowed.empty')}
          </div>
        ) : (
          alwaysAllowed.map((toolName) => (
            <div key={toolName} className="flex min-h-11 items-center justify-between gap-4 py-2.5">
              <code className="min-w-0 truncate font-mono text-xs/4 text-foreground">
                {toolName}
              </code>
              <button
                type="button"
                className={QUIET_ACTION}
                aria-label={t('agentProviders.alwaysAllowed.revokeLabel', { tool: toolName })}
                onClick={() => void revokeAlwaysAllowed(toolName)}
              >
                {t('agentProviders.alwaysAllowed.revoke')}
              </button>
            </div>
          ))
        )}
      </SettingsGroup>
    </div>
  )
}

const QUIET_ACTION =
  'shrink-0 rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

type StatusTone = 'ready' | 'pending' | 'warning' | 'off'

const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  ready: 'bg-green-500',
  pending: 'bg-amber-500',
  warning: 'bg-amber-500',
  off: 'border border-muted-foreground/60'
}

const STATUS_TEXT_CLASS: Record<StatusTone, string> = {
  ready: 'text-green-600',
  pending: 'text-muted-foreground',
  warning: 'text-amber-600',
  off: 'text-muted-foreground'
}

function cliStatusTone(cli: AgentBackendStatus | undefined): StatusTone {
  if (!cli) return 'off'
  if (cli.reason === 'agent_unavailable') return 'warning'
  if (cli.available) return 'ready'
  if (cli.version && cli.minimumRequired) return 'warning'
  return 'off'
}

function StatusDot({ tone }: { tone: StatusTone }): React.JSX.Element {
  return (
    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[tone])} />
  )
}

function GroupHeading({ label, hint }: { label: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 pb-1.5">
      <h4 className="font-semibold text-xs/4 text-foreground">{label}</h4>
      {hint && <span className="text-xs/4 text-muted-foreground">{hint}</span>}
    </div>
  )
}

function FieldRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-t border-border py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs/4 text-foreground">{label}</span>
        {hint && <span className="text-[11px]/4 text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (!active) onChange(option.value)
            }}
            className={cn(
              'rounded-[5px] px-2.5 py-1 text-xs/4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
