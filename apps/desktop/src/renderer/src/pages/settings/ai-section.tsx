import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Brain, Info, Loader2, CheckCircle, XCircle, RefreshCw } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { AIInlineSettings as AIInlineSettingsPanel } from './ai-inline-section'

const log = createLogger('Page:Settings:AI')

interface AIModelStatus {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
  embeddingCount?: number
}

export function AISettings() {
  const [settings, setSettings] = useState<{ enabled: boolean }>({ enabled: false })
  const [modelStatus, setModelStatus] = useState<AIModelStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingModel, setIsLoadingModel] = useState(false)
  const [isReindexing, setIsReindexing] = useState(false)
  const [reindexProgress, setReindexProgress] = useState<{
    current: number
    total: number
    phase: string
  } | null>(null)

  useEffect(() => {
    const loadData = async (): Promise<void> => {
      try {
        const [aiSettings, status] = await Promise.all([
          window.api.settings.getAISettings(),
          window.api.settings.getAIModelStatus()
        ])
        setSettings(aiSettings)
        setModelStatus(status)
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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">AI Assistant</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">AI Assistant</h3>
        <p className="text-sm text-muted-foreground">
          Configure AI-powered features like smart filing suggestions. All AI processing runs
          locally on your device.
        </p>
      </div>

      <Separator />

      {/* Enable/Disable AI */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="ai-enabled">Enable AI Features</Label>
          <p className="text-sm text-muted-foreground">
            Use AI to suggest folders and tags when filing items
          </p>
        </div>
        <Switch id="ai-enabled" checked={settings.enabled} onCheckedChange={handleToggleEnabled} />
      </div>

      <Separator />

      {/* Local Model Status */}
      <div className="space-y-4">
        <div>
          <Label>Local Embedding Model</Label>
          <p className="text-sm text-muted-foreground mt-1">
            Embeddings are generated locally using the all-MiniLM-L6-v2 model. No data is sent to
            external servers.
          </p>
        </div>

        {/* Model Info Card */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium">{modelStatus?.name || 'all-MiniLM-L6-v2'}</span>
            </div>
            <div className="flex items-center gap-2">
              {modelStatus?.loaded ? (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircle className="w-4 h-4" />
                  Loaded
                </span>
              ) : modelStatus?.loading || isLoadingModel ? (
                <span className="flex items-center gap-1 text-sm text-amber-600">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </span>
              ) : (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <XCircle className="w-4 h-4" />
                  Not loaded
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Dimensions:</span>
              <span className="ml-2">{modelStatus?.dimension || 384}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Embeddings:</span>
              <span className="ml-2">{modelStatus?.embeddingCount ?? 0}</span>
            </div>
          </div>

          {modelStatus?.error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <XCircle className="w-4 h-4" />
              {modelStatus.error}
            </div>
          )}

          {!modelStatus?.loaded && !isLoadingModel && (
            <Button onClick={handleLoadModel} className="w-full">
              Download & Load Model
            </Button>
          )}

          {isLoadingModel && reindexProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>
                  {reindexProgress.phase === 'downloading'
                    ? 'Downloading model...'
                    : 'Loading model...'}
                </span>
                <span>{Math.round(reindexProgress.current)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${reindexProgress.current}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            The model (~23MB) will be downloaded once and cached locally. All embedding generation
            happens on your device for complete privacy.
          </p>
        </div>
      </div>

      <Separator />

      {/* Reindex Embeddings */}
      <div className="space-y-4">
        <div>
          <Label>Embedding Index</Label>
          <p className="text-sm text-muted-foreground mt-1">
            Rebuild the AI embeddings index for all notes. This enables better similarity matching
            for filing suggestions.
          </p>
        </div>

        <Button
          variant="outline"
          onClick={handleReindexEmbeddings}
          disabled={isReindexing || !modelStatus?.loaded || !settings.enabled}
        >
          {isReindexing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Reindexing...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Rebuild Index
            </>
          )}
        </Button>

        {isReindexing &&
          reindexProgress &&
          reindexProgress.phase !== 'downloading' &&
          reindexProgress.phase !== 'loading' && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
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
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{
                    width: `${reindexProgress.total > 0 ? (reindexProgress.current / reindexProgress.total) * 100 : 0}%`
                  }}
                />
              </div>
            </div>
          )}

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            The embedding index is built automatically when notes are created or modified. Use this
            button to rebuild from scratch if suggestions seem inaccurate.
          </p>
        </div>
      </div>

      <Separator />

      <AIInlineSettingsPanel />
    </div>
  )
}
