import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Sparkles, Info, Loader2, CheckCircle, XCircle, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'

const log = createLogger('Page:Settings:AIInline')

const PROVIDER_OPTIONS = [
  { value: 'ollama', label: 'Ollama (Local)', description: 'Free, runs on your device' },
  { value: 'openai', label: 'OpenAI', description: 'GPT-4, GPT-4o, etc.' },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude Sonnet, Opus, etc.' }
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

  const updateSetting = useCallback(async (updates: Partial<AIInlineSettings>) => {
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
      const stopResult = (await window.electron.ipcRenderer.invoke('ai-inline:stop-server')) as {
        success: boolean
      }
      if (!stopResult.success) {
        toast.error('Failed to stop existing server')
        return
      }

      const startResult = (await window.electron.ipcRenderer.invoke('ai-inline:start-server')) as {
        success: boolean
        port?: number
        error?: string
      }

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
      <div className="space-y-4">
        <div>
          <h4 className="text-base font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Inline AI Editing
          </h4>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  const needsApiKey = settings.provider !== 'ollama'
  const models = MODEL_PRESETS[settings.provider] ?? []

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-base font-semibold flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Inline AI Editing
        </h4>
        <p className="text-sm text-muted-foreground">
          Select text in the editor to access AI commands like rewrite, summarize, and translate.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="ai-inline-enabled">Enable Inline AI</Label>
          <p className="text-sm text-muted-foreground">Show AI menu when editing notes</p>
        </div>
        <Switch
          id="ai-inline-enabled"
          checked={settings.enabled}
          onCheckedChange={handleToggleEnabled}
        />
      </div>

      {settings.enabled && (
        <>
          <Separator />

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={settings.provider} onValueChange={handleProviderChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <div className="flex flex-col">
                        <span>{opt.label}</span>
                        <span className="text-xs text-muted-foreground">{opt.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <Select
                value={settings.model}
                onValueChange={(model) => void updateSetting({ model })}
              >
                <SelectTrigger>
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
              <p className="text-xs text-muted-foreground">
                {settings.provider === 'ollama'
                  ? 'Make sure this model is pulled in Ollama first'
                  : 'Choose the model for AI editing'}
              </p>
            </div>

            {needsApiKey && (
              <div className="space-y-2">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showApiKey ? 'text' : 'password'}
                      value={settings.apiKey}
                      onChange={(e) => setSettings((prev) => ({ ...prev, apiKey: e.target.value }))}
                      onBlur={() => void updateSetting({ apiKey: settings.apiKey })}
                      placeholder={`Enter ${settings.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowApiKey((v) => !v)}
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Stored securely in your local vault. Never sent anywhere except the provider.
                </p>
              </div>
            )}

            {settings.provider === 'ollama' && (
              <div className="space-y-2">
                <Label>Ollama URL</Label>
                <Input
                  value={settings.baseUrl}
                  onChange={(e) => setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  onBlur={() => void updateSetting({ baseUrl: settings.baseUrl })}
                  placeholder="http://localhost:11434/v1"
                />
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={isTesting || (needsApiKey && !settings.apiKey)}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Testing...
                  </>
                ) : (
                  'Test Connection'
                )}
              </Button>
              {serverPort && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircle className="w-4 h-4" />
                  Active on port {serverPort}
                </span>
              )}
              {!serverPort && !isTesting && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <XCircle className="w-4 h-4" />
                  Not connected
                </span>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
            <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-muted-foreground">
              {settings.provider === 'ollama'
                ? 'Ollama runs entirely on your device. Install it from ollama.com and pull a model (e.g. ollama pull llama3.2).'
                : `API calls are sent directly to ${settings.provider === 'openai' ? 'OpenAI' : 'Anthropic'}. Usage is billed by the provider.`}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
