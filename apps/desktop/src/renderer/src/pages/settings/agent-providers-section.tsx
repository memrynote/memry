import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentLocalProviderPreset,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings
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

const PRESET_DEFAULTS: Record<Exclude<AgentLocalProviderPreset, 'custom'>, string> = {
  ollama: 'http://localhost:11434/v1',
  lm_studio: 'http://localhost:1234/v1',
  llama_cpp: 'http://127.0.0.1:8080/v1'
}

export function AgentProvidersSection(): React.JSX.Element | null {
  const { t } = useT('settings')
  const [settings, setSettings] = useState<AgentLocalProviderSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<AgentLocalProviderProbeResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.agent.getLocalProviderSettings().then((next) => {
      if (!cancelled) setSettings(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

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
    },
    []
  )

  const changePreset = useCallback((preset: AgentLocalProviderPreset) => {
    setSettings((current) => {
      if (!current) return current
      const baseUrl = preset === 'custom' ? current.baseUrl : PRESET_DEFAULTS[preset]
      return { ...current, preset, baseUrl }
    })
  }, [])

  const save = useCallback(async () => {
    if (!settings) return
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
      setApiKey('')
    } finally {
      setBusy(null)
    }
  }, [apiKey, settings])

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

  const probeTools = useCallback(async () => {
    setBusy('probe')
    try {
      setStatus(await window.api.agent.probeLocalProvider())
    } finally {
      setBusy(null)
    }
  }, [])

  if (!settings) return null

  return (
    <div>
      <SettingsHeader
        title={t('agentProviders.header.title')}
        subtitle={t('agentProviders.header.subtitle')}
        action={<StatusBadge status={status} />}
      />

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
            onChange={(event) => setApiKey(event.target.value)}
            className="h-8 text-xs"
          />
        </SettingRowTall>
      </SettingsGroup>

      <SettingsGroup label={t('agentProviders.groups.actions')}>
        <SettingRow label={t('agentProviders.actions.save')}>
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy === 'save'}>
            {t('agentProviders.actions.save')}
          </Button>
        </SettingRow>
        <SettingRow label={t('agentProviders.actions.test')}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void testConnection()}
            disabled={busy === 'test'}
          >
            {t('agentProviders.actions.test')}
          </Button>
        </SettingRow>
        <SettingRow label={t('agentProviders.actions.probe')}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void probeTools()}
            disabled={busy === 'probe'}
          >
            {t('agentProviders.actions.probe')}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

function StatusBadge({ status }: { status: AgentLocalProviderProbeResult | null }) {
  const { t } = useT('settings')
  if (!status) return null
  const label = status.toolsEnabled
    ? t('agentProviders.status.fullTools')
    : status.connected
      ? t('agentProviders.status.toolsDisabled')
      : t('agentProviders.status.disconnected')

  return (
    <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs/4 text-muted-foreground">
      {label}
    </span>
  )
}
