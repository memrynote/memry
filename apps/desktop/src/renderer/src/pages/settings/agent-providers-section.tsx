import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentAccessMode,
  AgentBackendStatus,
  AgentLocalProviderPreset,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings,
  AgentPreferences,
  AgentToolApprovalMode,
  BackendStatusesResponse
} from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  SettingsGroup,
  SettingsHeader,
  SettingRow,
  SettingRowTall
} from '@/components/settings/settings-primitives'
import { RefreshCw } from '@/lib/icons'
import { trackTelemetry } from '@/lib/telemetry'

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

  const connectionError =
    status && (!status.connected || !status.modelAvailable) ? status.detail : null

  const cliStatusText = (cli: AgentBackendStatus | undefined): string => {
    if (!cli) return t('agentProviders.cliAgents.status.notDetected')
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

  if (!settings || !preferences) return null

  return (
    <div>
      {!embedded && (
        <SettingsHeader
          title={t('agentProviders.header.title')}
          subtitle={t('agentProviders.header.subtitle')}
        />
      )}

      <SettingsGroup label={t('agentProviders.permissions.group')}>
        <SettingRow
          label={t('agentProviders.permissions.access.label')}
          description={t('agentProviders.permissions.access.description')}
        >
          <Select
            value={preferences.accessMode}
            onValueChange={(value) => void changeAccessMode(value as AgentAccessMode)}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vault_only">
                {t('agentProviders.permissions.access.vaultOnly')}
              </SelectItem>
              <SelectItem value="computer_access">
                {t('agentProviders.permissions.access.computerAccess')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label={t('agentProviders.permissions.confirm.label')}
          description={t('agentProviders.permissions.confirm.description')}
        >
          <Select
            value={preferences.toolApprovalMode}
            onValueChange={(value) => void changeToolApprovalMode(value as AgentToolApprovalMode)}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always_accept">
                {t('agentProviders.permissions.confirm.alwaysAllow')}
              </SelectItem>
              <SelectItem value="ask">
                {t('agentProviders.permissions.confirm.askBeforeChanges')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('agentProviders.groups.cliAgents')}>
        <SettingRow
          label={t('agentProviders.cliAgents.claude.label')}
          description={t('agentProviders.cliAgents.claude.description')}
        >
          <span
            className={
              backendStatuses?.claude_cli.available
                ? 'text-xs/4 text-green-600'
                : 'text-xs/4 text-muted-foreground'
            }
          >
            {cliStatusText(backendStatuses?.claude_cli)}
          </span>
        </SettingRow>
        <SettingRow
          label={t('agentProviders.cliAgents.codex.label')}
          description={t('agentProviders.cliAgents.codex.description')}
        >
          <span
            className={
              backendStatuses?.codex_cli.available
                ? 'text-xs/4 text-green-600'
                : 'text-xs/4 text-muted-foreground'
            }
          >
            {cliStatusText(backendStatuses?.codex_cli)}
          </span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('agentProviders.groups.local')}>
        <SettingRow label={t('agentProviders.fields.preset.label')}>
          <Select
            value={settings.preset}
            onValueChange={(value) => changePreset(value as AgentLocalProviderPreset)}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ollama">{t('agentProviders.presets.ollama')}</SelectItem>
              <SelectItem value="lm_studio">{t('agentProviders.presets.lmStudio')}</SelectItem>
              <SelectItem value="llama_cpp">{t('agentProviders.presets.llamaCpp')}</SelectItem>
              <SelectItem value="custom">{t('agentProviders.presets.custom')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRowTall
          label={t('agentProviders.fields.baseUrl.label')}
          description={t('agentProviders.fields.baseUrl.description')}
        >
          <Input
            value={settings.baseUrl}
            onChange={(event) => updateSetting('baseUrl', event.target.value)}
            className="h-8 font-mono text-xs"
          />
        </SettingRowTall>
        {nonLoopback && (
          <SettingRow
            label={t('agentProviders.fields.allowNonLoopback.label')}
            description={t('agentProviders.fields.allowNonLoopback.description')}
          >
            <Checkbox
              checked={settings.allowNonLoopback}
              onCheckedChange={(checked) => updateSetting('allowNonLoopback', checked === true)}
            />
          </SettingRow>
        )}
        <SettingRowTall
          label={t('agentProviders.fields.model.label')}
          description={t('agentProviders.fields.model.description')}
        >
          <div className="flex gap-2">
            <Input
              value={settings.model}
              onChange={(event) => updateSetting('model', event.target.value)}
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void loadModels()}
              disabled={busy === 'models'}
            >
              <RefreshCw className="size-3.5" />
              {t('agentProviders.actions.models')}
            </Button>
          </div>
          {models.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {models.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => updateSetting('model', model)}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {model}
                </button>
              ))}
            </div>
          )}
        </SettingRowTall>
        <SettingRowTall
          label={t('agentProviders.fields.apiKey.label')}
          description={
            settings.apiKeyConfigured
              ? t('agentProviders.fields.apiKey.configured')
              : t('agentProviders.fields.apiKey.description')
          }
        >
          <Input
            value={apiKey}
            type="password"
            onChange={(event) => updateApiKey(event.target.value)}
            className="h-8 text-xs"
          />
        </SettingRowTall>
        {(busy === 'save' || status) && (
          <SettingRow label={t('agentProviders.status.label')}>
            {busy === 'save' ? (
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
            ) : (
              <span className="text-xs/4 text-green-600">
                {t('agentProviders.status.connected')}
              </span>
            )}
          </SettingRow>
        )}
      </SettingsGroup>
    </div>
  )
}
