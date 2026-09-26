import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Loader2, XCircle, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { AIInlineSettings as AIInlineSettingsPanel } from './ai-inline-section'
import { AgentProvidersSection } from './agent-providers-section'
import { AgentMcpSection } from './agent-mcp-section'
import { CommandLineSettings } from './command-line-section'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  COMPACT_SELECT,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'
import type { SettingsFocusTarget } from '@/contexts/settings-modal-context'

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

export type AISettingsTab = 'models' | 'agents' | 'connect'

const AI_TABS_LIST =
  'h-auto w-full justify-start gap-5 rounded-none border-b border-border bg-transparent p-0'
const AI_TAB =
  'rounded-none border-b-2 border-transparent bg-transparent px-0 pb-2 pt-0 text-[13px]/4 text-muted-foreground shadow-none data-[state=active]:border-[var(--tint)] data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none'

const QUIET_ACTION =
  'inline-flex items-center gap-1.5 rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const ROW_PRIMARY_ACTION = 'h-7 px-2.5 text-xs/4'

const VOICE_PROVIDER_OPTIONS = [
  { value: 'local', labelKey: 'ai.v2.voice.local' },
  { value: 'openai', labelKey: 'ai.v2.voice.openai' }
] as const satisfies ReadonlyArray<{
  value: VoiceTranscriptionSettings['provider']
  labelKey: string
}>

type StatusTone = 'ready' | 'progress' | 'idle'

const STATUS_DOT: Record<StatusTone, string> = {
  ready: 'bg-emerald-500',
  progress: 'bg-amber-500',
  idle: 'border border-muted-foreground/60'
}

function StatusIndicator({
  tone,
  label,
  title
}: {
  tone: StatusTone
  label: string
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 text-xs/4 text-muted-foreground"
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} />
      {label}
    </span>
  )
}

interface LocalModelRowProps {
  label: string
  modelName: string
  hint: string
  status: ReactNode
  action: ReactNode
}

function LocalModelRow({ label, modelName, hint, status, action }: LocalModelRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-14 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="shrink-0 text-[13px]/4 text-foreground">{label}</span>
          <span className="truncate font-mono text-xs/4 text-muted-foreground">{modelName}</span>
        </div>
        <span className="text-xs/4 text-muted-foreground">{hint}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="w-28">{status}</div>
        <div className="flex min-w-32 justify-end">{action}</div>
      </div>
    </div>
  )
}

function InlineProgress({
  label,
  value,
  percent
}: {
  label: string
  value: string
  percent: number
}) {
  return (
    <div className="flex flex-col gap-1.5 pb-3">
      <div className="flex justify-between gap-4 text-xs/4 text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-[var(--tint)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function RowError({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-1 pb-3 text-xs/4 text-destructive">
      <XCircle className="size-3.5 shrink-0" />
      {message}
    </p>
  )
}

interface AISettingsProps {
  initialTab?: AISettingsTab
  /** Only `voice-local-model` targets this section; other targets are ignored. */
  focusTarget?: SettingsFocusTarget | null
  focusRequestId?: number
}

export function AISettings({
  initialTab = 'models',
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
        <Tabs defaultValue={initialTab}>
          <TabsList className={AI_TABS_LIST}>
            <TabsTrigger value="models" className={AI_TAB}>
              {t('ai.tabs.models')}
            </TabsTrigger>
            <TabsTrigger value="agents" className={AI_TAB}>
              {t('ai.tabs.agents')}
            </TabsTrigger>
            <TabsTrigger value="connect" className={AI_TAB}>
              {t('ai.tabs.connect')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="mt-6">
            <div className="flex items-baseline gap-2 pb-1.5">
              <h4 className="font-semibold text-xs/4 text-foreground">
                {t('ai.v2.onDevice.label')}
              </h4>
              <span className="text-xs/4 text-muted-foreground">{t('ai.v2.onDevice.hint')}</span>
            </div>
            <SettingsGroup>
              <div data-testid="embedding-model-row">
                <LocalModelRow
                  label={t('ai.v2.embedding.label')}
                  modelName={modelStatus?.name || 'all-MiniLM-L6-v2'}
                  hint={t('ai.v2.embedding.hint', {
                    dimension: modelStatus?.dimension || 384,
                    count: modelStatus?.embeddingCount ?? 0
                  })}
                  status={
                    modelStatus?.loaded ? (
                      <StatusIndicator tone="ready" label={t('ai.embedding.loaded')} />
                    ) : modelStatus?.loading || isLoadingModel ? (
                      <StatusIndicator tone="progress" label={t('ai.embedding.loading')} />
                    ) : (
                      <StatusIndicator tone="idle" label={t('ai.voice.status.notDownloaded')} />
                    )
                  }
                  action={
                    modelStatus?.loaded ? (
                      <button
                        type="button"
                        onClick={() => void handleReindexEmbeddings()}
                        disabled={isReindexing || !settings.enabled}
                        className={QUIET_ACTION}
                      >
                        {isReindexing && <Loader2 className="size-3 animate-spin" />}
                        {t('ai.embedding.rebuildIndex')}
                      </button>
                    ) : !isLoadingModel ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleLoadModel()}
                        className={ROW_PRIMARY_ACTION}
                      >
                        {t('ai.embedding.downloadLoad')}
                      </Button>
                    ) : null
                  }
                />
                {isLoadingModel && reindexProgress && (
                  <InlineProgress
                    label={
                      reindexProgress.phase === 'downloading'
                        ? t('ai.embedding.downloadingModel')
                        : t('ai.embedding.loadingModel')
                    }
                    value={`${Math.round(reindexProgress.current)}%`}
                    percent={reindexProgress.current}
                  />
                )}
                {isReindexing &&
                  reindexProgress &&
                  reindexProgress.phase !== 'downloading' &&
                  reindexProgress.phase !== 'loading' && (
                    <InlineProgress
                      label={
                        reindexProgress.phase === 'scanning'
                          ? t('ai.embedding.scanning')
                          : reindexProgress.phase === 'embedding'
                            ? t('ai.embedding.generating')
                            : t('ai.embedding.complete')
                      }
                      value={`${reindexProgress.current} / ${reindexProgress.total}`}
                      percent={
                        reindexProgress.total > 0
                          ? (reindexProgress.current / reindexProgress.total) * 100
                          : 0
                      }
                    />
                  )}
                {modelStatus?.error && <RowError message={modelStatus.error} />}
              </div>

              <div
                key={voiceModelFocusRequestId ?? 'voice-local-model'}
                data-testid="voice-local-model-row"
                className={cn(voiceModelFocusRequestId !== null && 'settings-focus-heartbeat')}
              >
                <LocalModelRow
                  label={t('ai.v2.voiceModel.label')}
                  modelName={voiceModelStatus?.name || 'Whisper Small'}
                  hint={t('ai.voice.cacheHint')}
                  status={
                    voiceModelStatus?.loaded ? (
                      <StatusIndicator tone="ready" label={t('ai.voice.status.ready')} />
                    ) : isDownloadingVoiceModel || voiceModelStatus?.loading ? (
                      <StatusIndicator tone="progress" label={t('ai.voice.status.downloading')} />
                    ) : voiceModelStatus?.downloaded ? (
                      <StatusIndicator tone="ready" label={t('ai.voice.status.downloaded')} />
                    ) : (
                      <StatusIndicator tone="idle" label={t('ai.voice.status.notDownloaded')} />
                    )
                  }
                  action={
                    !voiceModelStatus?.downloaded && !isDownloadingVoiceModel ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('ai.voice.download')}
                        onClick={() => void handleDownloadVoiceModel()}
                        className={ROW_PRIMARY_ACTION}
                      >
                        {t('ai.v2.download')}
                      </Button>
                    ) : null
                  }
                />
                {voiceModelProgress && (
                  <InlineProgress
                    label={voiceModelProgress.status || t('ai.voice.preparing')}
                    value={`${Math.round(voiceModelProgress.progress)}%`}
                    percent={voiceModelProgress.progress}
                  />
                )}
                {voiceModelStatus?.error && <RowError message={voiceModelStatus.error} />}
              </div>
            </SettingsGroup>

            <AIInlineSettingsPanel />

            <SettingsGroup label={t('ai.v2.voice.group')}>
              <SettingRow
                label={t('ai.v2.voice.transcribeWith')}
                description={t('ai.voice.providerDescription')}
              >
                <div
                  role="group"
                  aria-label={t('ai.v2.voice.transcribeWith')}
                  className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5"
                >
                  {VOICE_PROVIDER_OPTIONS.map((option) => {
                    const isActive = voiceSettings.provider === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => {
                          if (!isActive) void handleVoiceProviderChange(option.value)
                        }}
                        className={cn(
                          'rounded-[5px] px-2.5 py-0.5 text-xs/4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          isActive
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {t(option.labelKey)}
                      </button>
                    )
                  })}
                </div>
              </SettingRow>

              <SettingRow
                label={t('ai.v2.voice.nameBy')}
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

              {voiceSettings.provider === 'openai' && (
                <SettingRow
                  label={t('ai.voice.apiKey')}
                  description={t('ai.voice.apiKeyDescription')}
                >
                  <div className="flex items-center gap-2">
                    <StatusIndicator
                      tone={hasVoiceApiKey ? 'ready' : 'idle'}
                      label={
                        hasVoiceApiKey ? t('ai.v2.voice.keySaved') : t('ai.v2.voice.keyNotSet')
                      }
                      title={hasVoiceApiKey ? t('ai.voice.keySaved') : undefined}
                    />
                    <Input
                      type={showVoiceApiKey ? 'text' : 'password'}
                      value={voiceApiKey}
                      onChange={(event) => setVoiceApiKey(event.target.value)}
                      placeholder={
                        hasVoiceApiKey ? t('ai.voice.replaceKey') : t('ai.voice.enterKey')
                      }
                      className="h-7 w-44 font-mono text-xs/4"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowVoiceApiKey((visible) => !visible)}
                      tabIndex={-1}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    >
                      {showVoiceApiKey ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSaveVoiceApiKey()}
                      disabled={!voiceApiKey.trim()}
                      className={ROW_PRIMARY_ACTION}
                    >
                      {t('ai.voice.saveKey')}
                    </Button>
                  </div>
                </SettingRow>
              )}
            </SettingsGroup>
          </TabsContent>

          <TabsContent value="agents" className="mt-6">
            <AgentProvidersSection embedded />
          </TabsContent>

          <TabsContent value="connect" className="mt-6">
            <AgentMcpSection embedded />
            <div id="settings-anchor-command-line">
              <CommandLineSettings embedded />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
