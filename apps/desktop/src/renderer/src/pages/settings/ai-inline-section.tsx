import { useState, useCallback, useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Loader2, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { friendlyError } from '@/hooks/use-ai-inline'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import {
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT,
  SETTINGS_GROUP_LABEL
} from '@/components/settings/settings-primitives'

const log = createLogger('Page:Settings:AIInline')

const QUIET_ACTION =
  'inline-flex items-center gap-1.5 rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

const PROVIDER_LABEL_KEYS: Record<AIInlineSettings['provider'], string> = {
  ollama: 'ai.inline.providers.ollama',
  openai: 'ai.inline.providers.openai',
  anthropic: 'ai.inline.providers.anthropic',
  google: 'ai.inline.providers.google'
}

const PROVIDER_OPTIONS = [
  { value: 'ollama', labelKey: PROVIDER_LABEL_KEYS.ollama },
  { value: 'openai', labelKey: PROVIDER_LABEL_KEYS.openai },
  { value: 'anthropic', labelKey: PROVIDER_LABEL_KEYS.anthropic },
  { value: 'google', labelKey: PROVIDER_LABEL_KEYS.google }
] as const

const MODEL_PRESETS: Record<string, string[]> = {
  ollama: ['qwen2.5:7b', 'llama3.2', 'llama3.1', 'mistral', 'gemma2', 'phi3'],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
  google: [
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ]
}

const BASE_URL_DEFAULTS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  openai: '',
  anthropic: '',
  google: ''
}

/**
 * Live Ollama catalogue for the selected endpoint, or null while the provider
 * is something else (or Ollama is unreachable, which is a normal state and
 * leaves the caller on its presets).
 */
function useOllamaModels(provider: AIInlineSettings['provider'], baseUrl: string): string[] | null {
  const [models, setModels] = useState<string[] | null>(null)

  useEffect(() => {
    if (provider !== 'ollama') return
    let cancelled = false
    void (async () => {
      try {
        const res = (await window.electron.ipcRenderer.invoke('ai-inline:list-ollama-models')) as {
          success: boolean
          models?: string[]
        }
        // The provider or endpoint may have changed while the probe was in
        // flight, in which case this late answer describes the old one.
        if (cancelled) return
        if (res.success && res.models?.length) setModels(res.models)
      } catch {
        // unreachable Ollama → keep preset fallback
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider, baseUrl])

  return models
}

/** Presets for the provider, with a hand-typed model kept at the top. */
function modelChoices(
  provider: AIInlineSettings['provider'],
  selectedModel: string,
  ollamaModels: string[] | null
): string[] {
  const presets =
    provider === 'ollama' ? (ollamaModels ?? MODEL_PRESETS.ollama) : (MODEL_PRESETS[provider] ?? [])
  return selectedModel && !presets.includes(selectedModel) ? [selectedModel, ...presets] : presets
}

export function AIInlineSettings(): React.JSX.Element {
  const { t: tPhaseF } = useT('settings')
  const { t } = useT('settings')
  const [settings, setSettings] = useState<AIInlineSettings>(AI_INLINE_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [isTesting, setIsTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [serverPort, setServerPort] = useState<number | null>(null)

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const [result, port] = await Promise.all([
          window.electron.ipcRenderer.invoke('ai-inline:get-settings') as Promise<AIInlineSettings>,
          window.electron.ipcRenderer.invoke('ai-inline:get-server-port') as Promise<number | null>
        ])
        setSettings(result)
        setServerPort(port)
      } catch (error) {
        log.error('Failed to load AI inline settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    void load()
  }, [])

  const ollamaModels = useOllamaModels(settings.provider, settings.baseUrl)

  const updateSetting = useCallback(
    async (updates: Partial<AIInlineSettings>) => {
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'ai-inline:set-settings',
          updates
        )) as {
          success: boolean
          error?: string
        }
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.inline.updateFailed')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.inline.updateFailed')))
      }
    },
    [t]
  )

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      await updateSetting({ enabled })
      toast.success(enabled ? t('ai.inline.enabled') : t('ai.inline.disabled'))
    },
    [updateSetting, t]
  )

  const handleProviderChange = useCallback(
    async (provider: AIInlineSettings['provider']) => {
      const defaultModel = MODEL_PRESETS[provider]?.[0] ?? ''
      const baseUrl = BASE_URL_DEFAULTS[provider] ?? ''
      await updateSetting({ provider, model: defaultModel, baseUrl })
    },
    [updateSetting]
  )

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true)
    try {
      // No stop-first: startChatServer reuses the running port when settings are
      // unchanged, so the proxy port stays stable instead of incrementing each test.
      const startResult = (await window.electron.ipcRenderer.invoke('ai-inline:start-server')) as {
        success: boolean
        port?: number
        error?: string
      }

      if (!startResult.success || !startResult.port) {
        setServerPort(null)
        toast.error(extractErrorMessage(startResult.error, t('ai.inline.connectFailed')))
        return
      }

      // The proxy starts without ever contacting the provider, so a running port does
      // not prove Ollama is reachable. Probe it for real before showing "connected".
      if (settings.provider === 'ollama') {
        const probe = (await window.electron.ipcRenderer.invoke(
          'ai-inline:list-ollama-models'
        )) as { success: boolean; error?: string }
        if (!probe.success) {
          setServerPort(null)
          toast.error(friendlyError(probe.error ?? t('ai.inline.connectFailed'), 'ollama'))
          return
        }
      }

      setServerPort(startResult.port)
      toast.success(t('ai.inline.connected', { port: startResult.port }))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.inline.testFailed')))
    } finally {
      setIsTesting(false)
    }
  }, [settings.provider, t])

  if (isLoading) {
    return (
      <div className="pb-6">
        <h4 className={SETTINGS_GROUP_LABEL}>{t('ai.v2.inline.group')}</h4>
        <p className="text-xs/4 text-muted-foreground">{t('ai.inline.loading')}</p>
      </div>
    )
  }

  const needsApiKey = settings.provider !== 'ollama'
  const models = modelChoices(settings.provider, settings.model, ollamaModels)

  const connectionControls = (
    <>
      <span
        title={serverPort ? t('ai.inline.activePort', { port: serverPort }) : undefined}
        className="inline-flex w-24 items-center gap-1.5 text-xs/4 text-muted-foreground"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            serverPort ? 'bg-emerald-500' : 'border border-muted-foreground/60'
          )}
        />
        <span className="sr-only">{t('ai.inline.connection')}</span>
        {serverPort ? t('ai.v2.connected') : t('ai.inline.notConnected')}
      </span>
      <button
        type="button"
        onClick={() => void handleTestConnection()}
        disabled={isTesting || (needsApiKey && !settings.apiKey)}
        className={QUIET_ACTION}
      >
        {isTesting && <Loader2 className="size-3 animate-spin" />}
        {t('ai.inline.test')}
      </button>
    </>
  )

  return (
    <SettingsGroup label={t('ai.v2.inline.group')}>
      <SettingRow label={t('ai.v2.inline.enabled')} description={t('ai.inline.enableDescription')}>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(...args) => void handleToggleEnabled(...args)}
          className={ACCENT_SWITCH}
        />
      </SettingRow>

      {settings.enabled && (
        <SettingRow label={t('ai.inline.model')} description={t('ai.inline.modelDescription')}>
          <div className="flex items-center gap-2">
            <Select
              value={settings.provider}
              onValueChange={(value) =>
                void handleProviderChange(value as AIInlineSettings['provider'])
              }
            >
              <SelectTrigger aria-label={t('ai.inline.provider')} className={COMPACT_SELECT}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={settings.model} onValueChange={(model) => void updateSetting({ model })}>
              <SelectTrigger
                aria-label={t('ai.inline.model')}
                className={cn(COMPACT_SELECT, 'font-mono')}
              >
                <SelectValue placeholder={t('ai.inline.selectModel')} />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model} value={model} className="font-mono">
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingRow>
      )}

      {settings.enabled && needsApiKey && (
        <SettingRow label={t('ai.inline.apiKey')} description={t('ai.inline.apiKeyDescription')}>
          <div className="flex items-center gap-2">
            <Input
              type={showApiKey ? 'text' : 'password'}
              value={settings.apiKey}
              onChange={(e) => setSettings((prev) => ({ ...prev, apiKey: e.target.value }))}
              onBlur={() => void updateSetting({ apiKey: settings.apiKey })}
              placeholder={t('ai.inline.apiKeyPlaceholder', {
                provider: t(PROVIDER_LABEL_KEYS[settings.provider])
              })}
              className="h-7 w-44 font-mono text-xs/4"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowApiKey((v) => !v)}
              tabIndex={-1}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </Button>
            {connectionControls}
          </div>
        </SettingRow>
      )}

      {settings.enabled && settings.provider === 'ollama' && (
        <SettingRow
          label={t('ai.inline.ollamaUrl')}
          description={t('ai.inline.ollamaUrlDescription')}
        >
          <div className="flex items-center gap-2">
            <Input
              value={settings.baseUrl}
              onChange={(e) => setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))}
              onBlur={() => void updateSetting({ baseUrl: settings.baseUrl })}
              placeholder={tPhaseF('phaseF.pagesSettingsAiInlineSection.httpLocalhost11434V1')}
              className="h-7 w-52 font-mono text-xs/4"
            />
            {connectionControls}
          </div>
        </SettingRow>
      )}
    </SettingsGroup>
  )
}
