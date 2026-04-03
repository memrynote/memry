import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Brain, Loader2, CheckCircle, XCircle, RefreshCw, Mic, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { AIInlineSettings as AIInlineSettingsPanel } from './ai-inline-section'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  SettingRowTall,
  COMPACT_SELECT,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

const log = createLogger('Page:Settings:AI')

interface AIModelStatus {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
  embeddingCount?: number
}

interface VoiceTranscriptionSettings {
  provider: 'local' | 'openai'
}

interface VoiceModelStatus {
  name: string
  downloaded: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

export function AISettings() {
  const [settings, setSettings] = useState<{ enabled: boolean }>({ enabled: false })
  const [modelStatus, setModelStatus] = useState<AIModelStatus | null>(null)
  const [voiceSettings, setVoiceSettings] = useState<VoiceTranscriptionSettings>({
    provider: 'local'
  })
  const [voiceModelStatus, setVoiceModelStatus] = useState<VoiceModelStatus | null>(null)
  const [voiceApiKey, setVoiceApiKey] = useState('')
  const [hasVoiceApiKey, setHasVoiceApiKey] = useState(false)
  const [showVoiceApiKey, setShowVoiceApiKey] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingModel, setIsLoadingModel] = useState(false)
  const [isDownloadingVoiceModel, setIsDownloadingVoiceModel] = useState(false)
  const [voiceModelProgress, setVoiceModelProgress] = useState<{
    progress: number
    phase: string
    status?: string
  } | null>(null)
  const [isReindexing, setIsReindexing] = useState(false)
  const [reindexProgress, setReindexProgress] = useState<{
    current: number
    total: number
    phase: string
  } | null>(null)

  useEffect(() => {
    const loadData = async (): Promise<void> => {
      try {
        const [aiSettings, status, voiceConfig, voiceStatus, voiceKeyStatus] = await Promise.all([
          window.api.settings.getAISettings(),
          window.api.settings.getAIModelStatus(),
          window.api.settings.getVoiceTranscriptionSettings(),
          window.api.settings.getVoiceModelStatus(),
          window.api.settings.getVoiceTranscriptionOpenAIKeyStatus()
        ])
        setSettings(aiSettings)
        setModelStatus(status)
        setVoiceSettings(voiceConfig)
        setVoiceModelStatus(voiceStatus)
        setHasVoiceApiKey(voiceKeyStatus.hasApiKey)
      } catch (error) {
        log.error('Failed to load AI settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onEmbeddingProgress((event) => {
      if (event.phase === 'downloading' || event.phase === 'loading') {
        setIsLoadingModel(true)
        setReindexProgress({
          current: event.progress ?? 0,
          total: 100,
          phase: event.phase
        })
      } else if (event.phase === 'ready') {
        setIsLoadingModel(false)
        setReindexProgress(null)
        window.api.settings.getAIModelStatus().then(setModelStatus)
      } else if (event.phase === 'error') {
        setIsLoadingModel(false)
        setReindexProgress(null)
        setModelStatus((prev) =>
          prev ? { ...prev, error: event.status ?? 'Unknown error' } : null
        )
      } else {
        setReindexProgress(event)
        if (event.phase === 'complete') {
          setTimeout(() => {
            setIsReindexing(false)
            setReindexProgress(null)
            window.api.settings.getAIModelStatus().then(setModelStatus)
          }, 1000)
        }
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onVoiceModelProgress((event) => {
      if (event.phase === 'downloading' || event.phase === 'loading') {
        setIsDownloadingVoiceModel(true)
        setVoiceModelProgress({
          progress: event.progress ?? event.current ?? 0,
          phase: event.phase,
          status: event.status
        })
        return
      }

      if (event.phase === 'ready') {
        setIsDownloadingVoiceModel(false)
        setVoiceModelProgress(null)
        window.api.settings.getVoiceModelStatus().then(setVoiceModelStatus)
        return
      }

      if (event.phase === 'error') {
        setIsDownloadingVoiceModel(false)
        setVoiceModelProgress(null)
        setVoiceModelStatus((prev) =>
          prev ? { ...prev, error: event.status ?? 'Unknown error' } : null
        )
      }
    })

    return unsubscribe
  }, [])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    try {
      const result = await window.api.settings.setAISettings({ enabled })
      if (result.success) {
        setSettings((prev) => ({ ...prev, enabled }))
        toast.success(enabled ? 'AI features enabled' : 'AI features disabled')
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to update setting'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to update setting'))
    }
  }, [])

  const handleLoadModel = useCallback(async () => {
    setIsLoadingModel(true)
    try {
      const result = await window.api.settings.loadAIModel()
      if (result.success) {
        toast.success(result.message || 'Model loaded successfully')
        const status = await window.api.settings.getAIModelStatus()
        setModelStatus(status)
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to load model'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to load model'))
    } finally {
      setIsLoadingModel(false)
    }
  }, [])

  const handleReindexEmbeddings = useCallback(async () => {
    setIsReindexing(true)
    setReindexProgress({ current: 0, total: 0, phase: 'scanning' })
    try {
      const result = await window.api.settings.reindexEmbeddings()
      if (result.success) {
        toast.success(
          `Embeddings reindexed: ${result.computed ?? 0} computed, ${result.skipped ?? 0} skipped`
        )
        setIsReindexing(false)
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to reindex embeddings'))
        setIsReindexing(false)
        setReindexProgress(null)
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to reindex embeddings'))
      setIsReindexing(false)
      setReindexProgress(null)
    }
  }, [])

  const handleVoiceProviderChange = useCallback(async (provider: 'local' | 'openai') => {
    try {
      const result = await window.api.settings.setVoiceTranscriptionSettings({ provider })
      if (result.success) {
        setVoiceSettings({ provider })
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to update voice provider'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to update voice provider'))
    }
  }, [])

  const handleDownloadVoiceModel = useCallback(async () => {
    setIsDownloadingVoiceModel(true)
    try {
      const result = await window.api.settings.downloadVoiceModel()
      if (result.success) {
        toast.success('Whisper Small downloaded')
        const status = await window.api.settings.getVoiceModelStatus()
        setVoiceModelStatus(status)
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to download Whisper Small'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to download Whisper Small'))
    } finally {
      setIsDownloadingVoiceModel(false)
    }
  }, [])

  const handleSaveVoiceApiKey = useCallback(async () => {
    if (!voiceApiKey.trim()) {
      return
    }

    try {
      const result = await window.api.settings.setVoiceTranscriptionOpenAIKey(voiceApiKey)
      if (result.success) {
        setVoiceApiKey('')
        setHasVoiceApiKey(true)
        toast.success('OpenAI key saved')
      } else {
        toast.error(extractErrorMessage(result.error, 'Failed to save OpenAI key'))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to save OpenAI key'))
    }
  }, [voiceApiKey])

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="AI Assistant" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title="AI Assistant"
        subtitle="Embeddings run locally. Voice memos can use Whisper Small or your OpenAI key."
      />

      <SettingsGroup>
        <SettingRow
          label="Enable AI Features"
          description="Smart filing suggestions and note connections"
        >
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleToggleEnabled}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Voice Transcription">
        <SettingRow label="Provider" description="Speech-to-text provider for voice memos">
          <Select value={voiceSettings.provider} onValueChange={handleVoiceProviderChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local (default)</SelectItem>
              <SelectItem value="openai">OpenAI (BYOK)</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRowTall
          label="Local Model"
          description="Whisper Small downloads on demand and stays cached locally"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium text-[13px]/4">
                  {voiceModelStatus?.name || 'Whisper Small'}
                </span>
                {voiceModelStatus?.loaded ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-green-500/15 text-green-600">
                    Ready
                  </span>
                ) : isDownloadingVoiceModel || voiceModelStatus?.loading ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-amber-500/15 text-amber-600">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Downloading
                  </span>
                ) : voiceModelStatus?.downloaded ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-emerald-500/15 text-emerald-600">
                    Downloaded
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-muted text-muted-foreground">
                    Not downloaded
                  </span>
                )}
              </div>
            </div>

            <div className="text-xs/4 text-muted-foreground">
              Not bundled with the app · Downloaded from Settings · Cached on this device
            </div>

            {voiceModelStatus?.error && (
              <div className="text-xs text-destructive flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" />
                {voiceModelStatus.error}
              </div>
            )}

            {voiceModelProgress && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px]/3 text-muted-foreground">
                  <span>{voiceModelProgress.status || 'Preparing Whisper Small...'}</span>
                  <span>{Math.round(voiceModelProgress.progress)}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--tint)] transition-all duration-300 rounded-full"
                    style={{ width: `${voiceModelProgress.progress}%` }}
                  />
                </div>
              </div>
            )}

            {!voiceModelStatus?.downloaded && !isDownloadingVoiceModel && (
              <Button onClick={handleDownloadVoiceModel} size="sm" className="w-full">
                Download Whisper Small
              </Button>
            )}
          </div>
        </SettingRowTall>

        {voiceSettings.provider === 'openai' && (
          <SettingRowTall
            label="OpenAI API Key"
            description="Stored in your OS keychain and used only for voice transcription"
          >
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  type={showVoiceApiKey ? 'text' : 'password'}
                  value={voiceApiKey}
                  onChange={(event) => setVoiceApiKey(event.target.value)}
                  placeholder={hasVoiceApiKey ? 'Replace saved OpenAI key' : 'Enter OpenAI API key'}
                  className="flex-1 h-7 text-xs/4"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowVoiceApiKey((visible) => !visible)}
                  tabIndex={-1}
                  className="h-7 w-7 p-0"
                >
                  {showVoiceApiKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveVoiceApiKey}
                  disabled={!voiceApiKey.trim()}
                  className="h-7 px-3"
                >
                  Save Key
                </Button>
              </div>

              {hasVoiceApiKey && (
                <div className="text-xs/4 text-muted-foreground flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                  API key saved in keychain
                </div>
              )}
            </div>
          </SettingRowTall>
        )}
      </SettingsGroup>

      <SettingsGroup label="Local Embedding Model">
        <div className="py-3 px-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-[13px]/4">
                {modelStatus?.name || 'all-MiniLM-L6-v2'}
              </span>
              {modelStatus?.loaded ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-green-500/15 text-green-600">
                  Loaded
                </span>
              ) : modelStatus?.loading || isLoadingModel ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-amber-500/15 text-amber-600">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading
                </span>
              ) : null}
            </div>
          </div>

          <div className="text-xs/4 text-muted-foreground">
            ~23MB · Cached locally · All on-device
          </div>

          <div className="flex gap-6">
            <div>
              <span className="uppercase text-[10px]/3 font-medium tracking-[0.05em] text-muted-foreground">
                Dimensions
              </span>
              <p className="text-[13px]/4 font-semibold text-foreground">
                {modelStatus?.dimension || 384}
              </p>
            </div>
            <div>
              <span className="uppercase text-[10px]/3 font-medium tracking-[0.05em] text-muted-foreground">
                Embeddings
              </span>
              <p className="text-[13px]/4 font-semibold text-foreground">
                {(modelStatus?.embeddingCount ?? 0).toLocaleString()}
              </p>
            </div>
          </div>

          {modelStatus?.error && (
            <div className="text-xs text-destructive flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" />
              {modelStatus.error}
            </div>
          )}

          {!modelStatus?.loaded && !isLoadingModel && (
            <Button onClick={handleLoadModel} size="sm" className="w-full">
              Download & Load Model
            </Button>
          )}

          {isLoadingModel && reindexProgress && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px]/3 text-muted-foreground">
                <span>
                  {reindexProgress.phase === 'downloading'
                    ? 'Downloading model...'
                    : 'Loading model...'}
                </span>
                <span>{Math.round(reindexProgress.current)}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--tint)] transition-all duration-300 rounded-full"
                  style={{ width: `${reindexProgress.current}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup label="Embedding Index">
        <SettingRow label="Rebuild Index" description="Regenerate embeddings for all notes">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReindexEmbeddings}
            disabled={isReindexing || !modelStatus?.loaded || !settings.enabled}
            className="gap-1.5"
          >
            {isReindexing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Rebuild
          </Button>
        </SettingRow>
        {isReindexing &&
          reindexProgress &&
          reindexProgress.phase !== 'downloading' &&
          reindexProgress.phase !== 'loading' && (
            <div className="px-4 pb-3 space-y-1.5">
              <div className="flex justify-between text-[10px]/3 text-muted-foreground">
                <span>
                  {reindexProgress.phase === 'scanning'
                    ? 'Scanning notes...'
                    : reindexProgress.phase === 'embedding'
                      ? 'Generating embeddings...'
                      : 'Complete!'}
                </span>
                <span>
                  {reindexProgress.current} / {reindexProgress.total}
                </span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--tint)] transition-all duration-300 rounded-full"
                  style={{
                    width: `${reindexProgress.total > 0 ? (reindexProgress.current / reindexProgress.total) * 100 : 0}%`
                  }}
                />
              </div>
            </div>
          )}
      </SettingsGroup>

      <AIInlineSettingsPanel />
    </div>
  )
}
