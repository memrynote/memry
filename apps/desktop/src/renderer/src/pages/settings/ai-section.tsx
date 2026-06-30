import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Bot,
  Brain,
  ChevronRight,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Mic,
  Eye,
  EyeOff,
  Server
} from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { AIInlineSettings as AIInlineSettingsPanel } from './ai-inline-section'
import { AgentProvidersSection } from './agent-providers-section'
import { AgentMcpSection } from './agent-mcp-section'
import { useT } from '@memry/i18n/renderer'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

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
  memoNameMode: 'transcript' | 'timestamp' | 'none'
}

interface VoiceModelStatus {
  name: string
  downloaded: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

type AssistantAdvancedPanel = 'agent-providers' | 'agent-mcp'
type AssistantFocusTarget = 'voice-local-model'

interface AISettingsProps {
  initialOpenPanel?: AssistantAdvancedPanel
  focusTarget?: AssistantFocusTarget | null
  focusRequestId?: number
}

export function AISettings({
  initialOpenPanel,
  focusTarget = null,
  focusRequestId = 0
}: AISettingsProps = {}) {
  const { t } = useT('settings')
  const [settings, setSettings] = useState<{ enabled: boolean }>({ enabled: false })
  const [modelStatus, setModelStatus] = useState<AIModelStatus | null>(null)
  const [voiceSettings, setVoiceSettings] = useState<VoiceTranscriptionSettings>({
    provider: 'local',
    memoNameMode: 'transcript'
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
  const [voiceModelFocusRequestId, setVoiceModelFocusRequestId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [aiSettings, status, voiceConfig, voiceStatus, voiceKeyStatus] = await Promise.all([
          window.api.settings.getAISettings(),
          window.api.settings.getAIModelStatus(),
          window.api.settings.getVoiceTranscriptionSettings(),
          window.api.settings.getVoiceModelStatus(),
          window.api.settings.getVoiceTranscriptionOpenAIKeyStatus()
        ])
        if (cancelled) return
        setSettings(aiSettings)
        setModelStatus(status)
        setVoiceSettings({
          provider: voiceConfig.provider,
          memoNameMode: voiceConfig.memoNameMode ?? 'transcript'
        })
        setVoiceModelStatus(voiceStatus)
        setHasVoiceApiKey(voiceKeyStatus.hasApiKey)
      } catch (error) {
        if (cancelled) return
        log.error('Failed to load AI settings:', error)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let completeTimeout: ReturnType<typeof setTimeout> | null = null

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
        void window.api.settings.getAIModelStatus().then(setModelStatus)
      } else if (event.phase === 'error') {
        setIsLoadingModel(false)
        setReindexProgress(null)
        setModelStatus((prev) =>
          prev ? { ...prev, error: event.status ?? t('ai.unknownError') } : null
        )
      } else {
        setReindexProgress(event)
        if (event.phase === 'complete') {
          if (completeTimeout) clearTimeout(completeTimeout)
          completeTimeout = setTimeout(() => {
            setIsReindexing(false)
            setReindexProgress(null)
            void window.api.settings.getAIModelStatus().then(setModelStatus)
          }, 1000)
        }
      }
    })

    return () => {
      if (completeTimeout) clearTimeout(completeTimeout)
      unsubscribe()
    }
  }, [t])

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
        void window.api.settings.getVoiceModelStatus().then(setVoiceModelStatus)
        return
      }

      if (event.phase === 'error') {
        setIsDownloadingVoiceModel(false)
        setVoiceModelProgress(null)
        setVoiceModelStatus((prev) =>
          prev ? { ...prev, error: event.status ?? t('ai.unknownError') } : null
        )
      }
    })

    return unsubscribe
  }, [t])

  // The active focus request for this row, derived from props during render
  // (React-recommended "adjust state on prop change" pattern). The timer effect
  // below clears it after the heartbeat animation completes.
  const voiceModelFocusSignal =
    focusTarget === 'voice-local-model' && !isLoading ? focusRequestId : null
  const [lastVoiceModelFocusSignal, setLastVoiceModelFocusSignal] = useState<number | null>(null)
  if (voiceModelFocusSignal !== lastVoiceModelFocusSignal) {
    setLastVoiceModelFocusSignal(voiceModelFocusSignal)
    setVoiceModelFocusRequestId(voiceModelFocusSignal)
  }

  useEffect(() => {
    if (voiceModelFocusRequestId === null) return
    const timeout = window.setTimeout(() => setVoiceModelFocusRequestId(null), 2700)
    return () => window.clearTimeout(timeout)
  }, [voiceModelFocusRequestId])

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        const result = await window.api.settings.setAISettings({ enabled })
        if (result.success) {
          setSettings((prev) => ({ ...prev, enabled }))
          toast.success(enabled ? t('ai.enable.enabled') : t('ai.enable.disabled'))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.enable.error')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.enable.error')))
      }
    },
    [t]
  )

  const handleLoadModel = useCallback(async () => {
    setIsLoadingModel(true)
    try {
      const result = await window.api.settings.loadAIModel()
      if (result.success) {
        toast.success(result.message || t('ai.embedding.loadSuccess'))
        const status = await window.api.settings.getAIModelStatus()
        setModelStatus(status)
      } else {
        toast.error(extractErrorMessage(result.error, t('ai.embedding.loadFailed')))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.embedding.loadFailed')))
    } finally {
      setIsLoadingModel(false)
    }
  }, [t])

  const handleReindexEmbeddings = useCallback(async () => {
    setIsReindexing(true)
    setReindexProgress({ current: 0, total: 0, phase: 'scanning' })
    try {
      const result = await window.api.settings.reindexEmbeddings()
      if (result.success) {
        toast.success(
          t('ai.embedding.reindexed', {
            computed: result.computed ?? 0,
            skipped: result.skipped ?? 0
          })
        )
        setIsReindexing(false)
      } else {
        toast.error(extractErrorMessage(result.error, t('ai.embedding.reindexFailed')))
        setIsReindexing(false)
        setReindexProgress(null)
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.embedding.reindexFailed')))
      setIsReindexing(false)
      setReindexProgress(null)
    }
  }, [t])

  const handleVoiceProviderChange = useCallback(
    async (provider: 'local' | 'openai') => {
      try {
        const result = await window.api.settings.setVoiceTranscriptionSettings({ provider })
        if (result.success) {
          setVoiceSettings((prev) => ({ ...prev, provider }))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.voice.providerError')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.voice.providerError')))
      }
    },
    [t]
  )

  const handleVoiceMemoNameModeChange = useCallback(
    async (memoNameMode: VoiceTranscriptionSettings['memoNameMode']) => {
      try {
        const result = await window.api.settings.setVoiceTranscriptionSettings({ memoNameMode })
        if (result.success) {
          setVoiceSettings((prev) => ({ ...prev, memoNameMode }))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.voice.namingError')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.voice.namingError')))
      }
    },
    [t]
  )

  const handleDownloadVoiceModel = useCallback(async () => {
    setIsDownloadingVoiceModel(true)
    try {
      const result = await window.api.settings.downloadVoiceModel()
      if (result.success) {
        toast.success(t('ai.voice.downloadedToast'))
        const status = await window.api.settings.getVoiceModelStatus()
        setVoiceModelStatus(status)
      } else {
        toast.error(extractErrorMessage(result.error, t('ai.voice.downloadError')))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.voice.downloadError')))
    } finally {
      setIsDownloadingVoiceModel(false)
    }
  }, [t])

  const handleSaveVoiceApiKey = useCallback(async () => {
    if (!voiceApiKey.trim()) {
      return
    }

    try {
      const result = await window.api.settings.setVoiceTranscriptionOpenAIKey(voiceApiKey)
      if (result.success) {
        setVoiceApiKey('')
        setHasVoiceApiKey(true)
        toast.success(t('ai.voice.keySavedToast'))
      } else {
        toast.error(extractErrorMessage(result.error, t('ai.voice.keySaveError')))
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.voice.keySaveError')))
    }
  }, [voiceApiKey, t])

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('ai.header.title')} subtitle={t('ai.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('ai.header.title')} subtitle={t('ai.header.subtitle')} />

      <SettingsGroup>
        <SettingRow label={t('ai.enable.label')} description={t('ai.enable.description')}>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(...args) => void handleToggleEnabled(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      {settings.enabled && (
        <>
          <SettingsGroup label={t('ai.groups.voice')}>
            <SettingRow
              label={t('ai.voice.provider')}
              description={t('ai.voice.providerDescription')}
            >
              <Select
                value={voiceSettings.provider}
                onValueChange={(value) =>
                  void handleVoiceProviderChange(value as 'local' | 'openai')
                }
              >
                <SelectTrigger className={COMPACT_SELECT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t('ai.voice.providers.local')}</SelectItem>
                  <SelectItem value="openai">{t('ai.voice.providers.openai')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label={t('ai.voice.memoNameMode')}
              description={t('ai.voice.memoNameModeDescription')}
            >
              <Select
                value={voiceSettings.memoNameMode}
                onValueChange={(value) =>
                  void handleVoiceMemoNameModeChange(
                    value as VoiceTranscriptionSettings['memoNameMode']
                  )
                }
              >
                <SelectTrigger className={COMPACT_SELECT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="transcript">{t('ai.voice.naming.transcript')}</SelectItem>
                  <SelectItem value="timestamp">{t('ai.voice.naming.timestamp')}</SelectItem>
                  <SelectItem value="none">{t('ai.voice.naming.none')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRowTall
              key={voiceModelFocusRequestId ?? 'voice-local-model'}
              data-testid="voice-local-model-row"
              className={cn(voiceModelFocusRequestId !== null && 'settings-focus-heartbeat')}
              label={t('ai.voice.localModel')}
              description={t('ai.voice.localModelDescription')}
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
                        {t('ai.voice.status.ready')}
                      </span>
                    ) : isDownloadingVoiceModel || voiceModelStatus?.loading ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-amber-500/15 text-amber-600">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t('ai.voice.status.downloading')}
                      </span>
                    ) : voiceModelStatus?.downloaded ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-emerald-500/15 text-emerald-600">
                        {t('ai.voice.status.downloaded')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-muted text-muted-foreground">
                        {t('ai.voice.status.notDownloaded')}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs/4 text-muted-foreground">{t('ai.voice.cacheHint')}</div>

                {voiceModelStatus?.error && (
                  <div className="text-xs text-destructive flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" />
                    {voiceModelStatus.error}
                  </div>
                )}

                {voiceModelProgress && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[10px]/3 text-muted-foreground">
                      <span>{voiceModelProgress.status || t('ai.voice.preparing')}</span>
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
                  <Button
                    onClick={() => void handleDownloadVoiceModel()}
                    size="sm"
                    className="w-full"
                  >
                    {t('ai.voice.download')}
                  </Button>
                )}
              </div>
            </SettingRowTall>

            {voiceSettings.provider === 'openai' && (
              <SettingRowTall
                label={t('ai.voice.apiKey')}
                description={t('ai.voice.apiKeyDescription')}
              >
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      type={showVoiceApiKey ? 'text' : 'password'}
                      value={voiceApiKey}
                      onChange={(event) => setVoiceApiKey(event.target.value)}
                      placeholder={
                        hasVoiceApiKey ? t('ai.voice.replaceKey') : t('ai.voice.enterKey')
                      }
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
                      onClick={() => void handleSaveVoiceApiKey()}
                      disabled={!voiceApiKey.trim()}
                      className="h-7 px-3"
                    >
                      {t('ai.voice.saveKey')}
                    </Button>
                  </div>

                  {hasVoiceApiKey && (
                    <div className="text-xs/4 text-muted-foreground flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                      {t('ai.voice.keySaved')}
                    </div>
                  )}
                </div>
              </SettingRowTall>
            )}
          </SettingsGroup>

          <SettingsGroup label={t('ai.groups.embeddingModel')}>
            <div className="py-3 px-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium text-[13px]/4">
                    {modelStatus?.name || 'all-MiniLM-L6-v2'}
                  </span>
                  {modelStatus?.loaded ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-green-500/15 text-green-600">
                      {t('ai.embedding.loaded')}
                    </span>
                  ) : modelStatus?.loading || isLoadingModel ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]/3 font-medium bg-amber-500/15 text-amber-600">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('ai.embedding.loading')}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="text-xs/4 text-muted-foreground">{t('ai.embedding.cacheHint')}</div>

              <div className="flex gap-6">
                <div>
                  <span className="uppercase text-[10px]/3 font-medium tracking-[0.05em] text-muted-foreground">
                    {t('ai.embedding.dimensions')}
                  </span>
                  <p className="text-[13px]/4 font-semibold text-foreground">
                    {modelStatus?.dimension || 384}
                  </p>
                </div>
                <div>
                  <span className="uppercase text-[10px]/3 font-medium tracking-[0.05em] text-muted-foreground">
                    {t('ai.embedding.embeddings')}
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
                <Button onClick={() => void handleLoadModel()} size="sm" className="w-full">
                  {t('ai.embedding.downloadLoad')}
                </Button>
              )}

              {isLoadingModel && reindexProgress && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px]/3 text-muted-foreground">
                    <span>
                      {reindexProgress.phase === 'downloading'
                        ? t('ai.embedding.downloadingModel')
                        : t('ai.embedding.loadingModel')}
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

          <SettingsGroup label={t('ai.groups.embeddingIndex')}>
            <SettingRow
              label={t('ai.embedding.rebuildIndex')}
              description={t('ai.embedding.rebuildDescription')}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleReindexEmbeddings()}
                disabled={isReindexing || !modelStatus?.loaded || !settings.enabled}
                className="gap-1.5"
              >
                {isReindexing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {t('ai.embedding.rebuild')}
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
                        ? t('ai.embedding.scanning')
                        : reindexProgress.phase === 'embedding'
                          ? t('ai.embedding.generating')
                          : t('ai.embedding.complete')}
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

          <div className="flex flex-col pb-6 gap-2">
            <AssistantAdvancedPanel
              title={t('agentProviders.header.title')}
              description={t('agentProviders.header.subtitle')}
              icon={<Bot className="size-3.5" />}
              defaultOpen={initialOpenPanel === 'agent-providers'}
            >
              <AgentProvidersSection embedded />
            </AssistantAdvancedPanel>

            <AssistantAdvancedPanel
              title={t('agentMcp.header.title')}
              description={t('agentMcp.header.subtitle')}
              icon={<Server className="size-3.5" />}
              defaultOpen={initialOpenPanel === 'agent-mcp'}
            >
              <AgentMcpSection embedded />
            </AssistantAdvancedPanel>
          </div>
        </>
      )}
    </div>
  )
}

function AssistantAdvancedPanel({
  title,
  description,
  icon,
  defaultOpen,
  children
}: {
  title: string
  description: string
  icon: ReactNode
  defaultOpen: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3 text-start transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className="font-medium text-[13px]/4 text-foreground">{title}</span>
            <span className="truncate text-xs/4 text-muted-foreground">{description}</span>
          </span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}
