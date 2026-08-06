/**
 * CanvasPage — spatial canvas tab (Excalidraw).
 *
 * Double-lazy: tab-content lazy-loads this page, and this page lazy-loads the
 * Excalidraw editor chunk, so @excalidraw/excalidraw stays out of the main
 * renderer bundle (and never loads while the feature flag is off).
 */

import React, { useEffect, useState } from 'react'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { canvasService, type Canvas } from '@/services/canvas-service'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

const LazyCanvasEditor = React.lazy(async () => ({
  default: (await import('./canvas-editor')).CanvasEditor
}))

const log = createLogger('SpatialCanvas')

interface CanvasPageProps {
  canvasId?: string
}

export const CanvasPage = ({ canvasId }: CanvasPageProps): React.JSX.Element => {
  const { t } = useT('common')
  const { flags, isLoading: flagsLoading } = useFeatureFlags()
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const enabled = flags.spatialCanvas

  useEffect(() => {
    if (!enabled || !canvasId) {
      return
    }
    let cancelled = false
    canvasService
      .get(canvasId)
      .then((result) => {
        if (cancelled) return
        if (result) {
          setCanvas(result)
          setError(null)
        } else {
          setError(t('canvas.notFound'))
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        log.error('Failed to load canvas', err)
        trackRendererError('canvas_open', err)
        setError(extractErrorMessage(err, t('canvas.openFailed')))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, canvasId, t])

  // Tab restore cannot gate hidden-phase tabs ('canvas' is not in
  // FEATURE_KEYS, so persisted canvas tabs are always restored). The flag
  // gate therefore lives here: with spatialCanvas off, a restored canvas tab
  // shows a placeholder and the Excalidraw chunk is never fetched.
  if (!enabled) {
    if (flagsLoading) {
      return <div className="h-full" />
    }
    return (
      <div
        className="h-full flex flex-col items-center justify-center p-8 text-center"
        data-canvas-placeholder=""
      >
        <h2 className="text-xl font-medium text-foreground mb-2">{t('canvas.disabledTitle')}</h2>
        <p className="text-sm text-text-tertiary">{t('canvas.disabledBody')}</p>
      </div>
    )
  }

  if (!canvasId || error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <p className="text-sm text-destructive">{error ?? t('canvas.notFound')}</p>
      </div>
    )
  }

  if (isLoading || !canvas) {
    return <div className="h-full" />
  }

  // The index knows this canvas but its document is not readable here (a
  // pre-file snapshot encrypted with a master key this device no longer has, or
  // a file moved out of the vault). Refuse to mount the editor: an empty scene
  // would autosave over ink that is still recoverable.
  if (canvas.unreadable) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center p-8 text-center"
        data-canvas-unreadable={canvas.id}
      >
        <h2 className="text-xl font-medium text-foreground mb-2">{t('canvas.unreadableTitle')}</h2>
        <p className="text-sm text-text-tertiary max-w-md">{t('canvas.unreadableBody')}</p>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0" data-canvas-page={canvas.id}>
      <React.Suspense fallback={<div className="h-full" />}>
        {/* Keyed so a canvasId prop change swaps in a fresh editor once the new
            scene arrives — initialData is mount-only, and a reused editor would
            persist the old scene under the new canvas id. */}
        <LazyCanvasEditor key={canvas.id} canvasId={canvas.id} initialScene={canvas.scene} />
      </React.Suspense>
    </div>
  )
}
