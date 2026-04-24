import { useState, useCallback, useEffect } from 'react'
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
import { Loader2, CheckCircle, XCircle, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { invoke } from '@/lib/ipc/invoke'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import {
  SettingsGroup,
  SettingRow,
  SettingRowTall,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

const log = createLogger('Page:Settings:AIInline')

const PROVIDER_OPTIONS = [
  { value: 'ollama', label: 'Ollama (Local)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' }
] as const

const MODEL_PRESETS: Record<string, string[]> = {
  ollama: ['qwen2.5:7b', 'llama3.2', 'llama3.1', 'mistral', 'gemma2', 'phi3'],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
}

const BASE_URL_DEFAULTS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  openai: '',
  anthropic: ''
}

export function AIInlineSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<AIInlineSettings>(AI_INLINE_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [isTesting, setIsTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [serverPort, setServerPort] = useState<number | null>(null)

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const [result, port] = await Promise.all([
          invoke<AIInlineSettings>('ai_inline_get_settings'),
          invoke<number | null>('ai_inline_get_server_port')
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

  const updateSetting = useCallback(async (updates: Partial<AIInlineSettings>) => {
    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'ai_inline_set_settings',
        updates as unknown as Record<string, unknown>
      )
      if (result.success) {
        setSettings((prev) => ({ ...prev, ...updates }))
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to update setting'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to update setting'))
    }
  }, [])

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      await updateSetting({ enabled })
      toast.success(enabled ? 'Inline AI editing enabled' : 'Inline AI editing disabled')
    },
    [updateSetting]
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
      const stopResult = await invoke<{ success: boolean }>('ai_inline_stop_server')
      if (!stopResult.success) {
        toast.error('Failed to stop existing server')
        return
      }

      const startResult = await invoke<{ success: boolean; port?: number; error?: string }>(
        'ai_inline_start_server'
      )

      if (startResult.success && startResult.port) {
        setServerPort(startResult.port)
        toast.success(`Connected! Server running on port ${startResult.port}`)
      } else {
        setServerPort(null)
        toast.error(startResult.error ?? 'Failed to connect')
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Connection test failed'))
    } finally {
      setIsTesting(false)
    }
  }, [])

  if (isLoading) {
    return (
      <div className="pb-6">
        <h4 className="uppercase pb-2 text-muted-foreground font-medium text-[11px]/3.5 tracking-[0.05em]">
          Inline AI Editing
        </h4>
        <p className="text-xs/4 text-muted-foreground">Loading...</p>
      </div>
    )
  }

  const needsApiKey = settings.provider !== 'ollama'
  const models = MODEL_PRESETS[settings.provider] ?? []

  return (
    <SettingsGroup label="Inline AI Editing">
      <SettingRow label="Enable Inline AI" description="Show AI menu when editing notes">
        <Switch
          checked={settings.enabled}
          onCheckedChange={handleToggleEnabled}
          className={ACCENT_SWITCH}
        />
      </SettingRow>

      {settings.enabled && (
        <>
          <SettingRow label="Provider" description="AI service for text operations">
            <Select value={settings.provider} onValueChange={handleProviderChange}>
              <SelectTrigger className={COMPACT_SELECT}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label="Model" description="Language model for rewrite and summarize">
            <Select value={settings.model} onValueChange={(model) => void updateSetting({ model })}>
              <SelectTrigger className={COMPACT_SELECT}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          {needsApiKey && (
            <SettingRowTall label="API Key" description="Stored locally, sent only to the provider">
              <div className="flex gap-2">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, apiKey: e.target.value }))}
                  onBlur={() => void updateSetting({ apiKey: settings.apiKey })}
                  placeholder={`Enter ${settings.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`}
                  className="flex-1 h-7 text-xs/4"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowApiKey((v) => !v)}
                  tabIndex={-1}
                  className="h-7 w-7 p-0"
                >
                  {showApiKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </Button>
              </div>
            </SettingRowTall>
          )}

          {settings.provider === 'ollama' && (
            <SettingRowTall label="Ollama URL" description="Local server address">
              <Input
                value={settings.baseUrl}
                onChange={(e) => setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))}
                onBlur={() => void updateSetting({ baseUrl: settings.baseUrl })}
                placeholder="http://localhost:11434/v1"
                className="h-7 text-xs/4"
              />
            </SettingRowTall>
          )}

          <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {serverPort ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  <span className="text-[13px]/4 font-medium text-foreground">Connection</span>
                  <span className="text-xs/4 text-muted-foreground">
                    Active on port {serverPort}
                  </span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-muted-foreground/40 shrink-0" />
                  <span className="text-[13px]/4 font-medium text-foreground">Connection</span>
                  <span className="text-xs/4 text-muted-foreground">Not connected</span>
                </>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={isTesting || (needsApiKey && !settings.apiKey)}
              className="h-7 px-3 text-xs/4"
            >
              {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Test'}
            </Button>
          </div>
        </>
      )}
    </SettingsGroup>
  )
}
