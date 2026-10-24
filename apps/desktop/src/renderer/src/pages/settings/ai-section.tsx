import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Loader2, Eye, EyeOff } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { AIInlineSettings as AIInlineSettingsPanel } from './ai-inline-section'
import { AgentProvidersSection } from './agent-providers-section'
import { InlineProgress, LocalModelRow, RowError, StatusIndicator } from './ai-section-parts'
import { SummarizeLongNotesRow } from './summarize-long-notes-row'
import { AgentMcpSection } from './agent-mcp-section'
import { CommandLineSettings } from './command-line-section'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useT } from '@memry/i18n/renderer'
import {
  VOICE_TRANSCRIPTION_LANGUAGES,
  VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
  type VoiceTranscriptionLanguage,
  type VoiceTranscriptionSettings
} from '@memry/contracts/settings-schemas'
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
import type { FoldAgentChoice } from '@memry/contracts/note-fold'
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
  const { t, i18n } = useT('settings')
  const [settings, setSettings] = useState<{
    enabled: boolean
    imageEmbeddings: boolean
    summarizeLongNotes: boolean
    summarizeAgent: FoldAgentChoice
  }>({
    enabled: false,
    imageEmbeddings: true,
    summarizeLongNotes: false,
    summarizeAgent: 'auto'
  })
  const [tab, setTab] = useState<AISettingsTab>(initialTab)
  const [modelStatus, setModelStatus] = useState<AIModelStatus | null>(null)
  const [voiceSettings, setVoiceSettings] = useState<VoiceTranscriptionSettings>(
    VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS
  )
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
        setSettings((prev) => ({ ...prev, ...aiSettings }))
        setModelStatus(status)
        setVoiceSettings({ ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS, ...voiceConfig })
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
    if (voiceModelFocusRequestId === null) return undefined
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

  const handleToggleImageEmbeddings = useCallback(
    async (imageEmbeddings: boolean) => {
      try {
        const result = await window.api.settings.setAISettings({ imageEmbeddings })
        if (result.success) {
          setSettings((prev) => ({ ...prev, imageEmbeddings }))
          toast.success(
            imageEmbeddings ? t('ai.imageSearch.enabled') : t('ai.imageSearch.disabled')
          )
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

  const handleVoiceLanguageChange = useCallback(
    async (language: VoiceTranscriptionLanguage) => {
      try {
        const result = await window.api.settings.setVoiceTranscriptionSettings({ language })
        if (result.success) {
          setVoiceSettings((prev) => ({ ...prev, language }))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.voice.languageError')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.voice.languageError')))
      }
    },
    [t]
  )

  const handleToggleAudioSearch = useCallback(
    async (audioSearch: boolean) => {
      try {
        const result = await window.api.settings.setVoiceTranscriptionSettings({ audioSearch })
        if (result.success) {
          setVoiceSettings((prev) => ({ ...prev, audioSearch }))
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.voice.audioSearchError')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.voice.audioSearchError')))
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

  const languageNames = new Intl.DisplayNames([i18n.language], { type: 'language' })
  const languageOptions = VOICE_TRANSCRIPTION_LANGUAGES.map((code) => ({
    code,
    label: languageNames.of(code) ?? code
  })).toSorted((a, b) => a.label.localeCompare(b.label, i18n.language))

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
        {settings.enabled && (
          <SummarizeLongNotesRow
            checked={settings.summarizeLongNotes}
            onSaved={(summarizeLongNotes) =>
              setSettings((prev) => ({ ...prev, summarizeLongNotes }))
            }
            agent={settings.summarizeAgent}
            onAgentSaved={(summarizeAgent) => setSettings((prev) => ({ ...prev, summarizeAgent }))}
            onOpenAgents={() => setTab('agents')}
            refreshKey={tab}
          />
        )}
        {settings.enabled && (
          <SettingRow
            label={t('ai.imageSearch.label')}
            description={t('ai.imageSearch.description')}
          >
            <Switch
              checked={settings.imageEmbeddings}
              onCheckedChange={(...args) => void handleToggleImageEmbeddings(...args)}
              className={ACCENT_SWITCH}
            />
          </SettingRow>
        )}
      </SettingsGroup>

      {settings.enabled && (
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix onValueChange yields string; the rendered options are exactly this union
        <Tabs value={tab} onValueChange={(value) => setTab(value as AISettingsTab)}>
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
            <SettingsGroup label={t('ai.v2.onDevice.label')} description={t('ai.v2.onDevice.hint')}>
              <div data-testid="embedding-model-row">
                <LocalModelRow
                  label={t('ai.v2.embedding.label')}
                  modelName={modelStatus?.name || 'EmbeddingGemma 2'}
                  hint={t('ai.v2.embedding.hint', {
                    dimension: modelStatus?.dimension || 256,
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
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- segmented radio group; a fieldset would add default borders and layout
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
                            ? 'bg-card text-foreground shadow-sm'
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
                      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix onValueChange yields string; the rendered options are exactly this union
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

              <SettingRow
                label={t('ai.voice.language')}
                description={t('ai.voice.languageDescription')}
              >
                <Select
                  value={voiceSettings.language ?? ''}
                  onValueChange={(value) =>
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix onValueChange yields string; the rendered options are exactly this union
                    void handleVoiceLanguageChange(value as VoiceTranscriptionLanguage)
                  }
                >
                  <SelectTrigger className={COMPACT_SELECT} aria-label={t('ai.voice.language')}>
                    <SelectValue placeholder={t('ai.voice.languageDefault')} />
                  </SelectTrigger>
                  <SelectContent>
                    {languageOptions.map(({ code, label }) => (
                      <SelectItem key={code} value={code}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label={t('ai.voice.audioSearch')}
                description={t('ai.voice.audioSearchDescription')}
              >
                <Switch
                  checked={voiceSettings.audioSearch !== false}
                  onCheckedChange={(...args) => void handleToggleAudioSearch(...args)}
                  className={ACCENT_SWITCH}
                  aria-label={t('ai.voice.audioSearch')}
                />
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
