/**
 * CanvasEditor — the Excalidraw-importing chunk.
 *
 * Loaded lazily from CanvasPage so @excalidraw/excalidraw (and its CSS) stay
 * out of the main renderer bundle. Fonts are self-hosted (see
 * public/excalidraw-asset-path.js) because the CSP blocks Excalidraw's CDN.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, serializeAsJSON, languages, defaultLang } from '@excalidraw/excalidraw'
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState
} from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useTheme } from 'next-themes'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { canvasService, onCanvasTooLarge } from '@/services/canvas-service'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { createScenePersister } from './canvas-persistence'
import { externalizeSceneAssets } from './canvas-externalize'
import { pickExcalidrawLangCode } from './excalidraw-lang'
import { CanvasCardLayer } from './canvas-card-overlay'
import { extractEntityRefs, type CardElement } from './canvas-cards'

const log = createLogger('SpatialCanvas')

const SCENE_SAVE_DEBOUNCE_MS = 800

/** Sentinel for a stored scene that exists but cannot be parsed. */
const CORRUPT = Symbol('corrupt-scene')

interface CanvasEditorProps {
  canvasId: string
  /** Serialized scene as stored (serializeAsJSON output), '' when never drawn on. */
  initialScene: string
}

export const CanvasEditor = ({ canvasId, initialScene }: CanvasEditorProps): React.JSX.Element => {
  const { t } = useT('common')
  const { resolvedTheme } = useTheme()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)

  const initialData = useMemo(() => {
    if (!initialScene) {
      return null
    }
    try {
      // serializeAsJSON output: { elements, appState, files } plus metadata
      // keys initialData ignores. Its exported appState is already cleaned
      // (no volatile keys, no collaborators), so it restores as-is.
      const parsed = JSON.parse(initialScene) as ExcalidrawInitialDataState
      return {
        elements: parsed.elements ?? [],
        appState: parsed.appState ?? {},
        files: parsed.files,
        scrollToContent: true
      } satisfies ExcalidrawInitialDataState
    } catch (err) {
      log.error('Failed to parse stored canvas scene; refusing to mount editor', err)
      return CORRUPT
    }
  }, [initialScene])

  const corrupt = initialData === CORRUPT

  // §5.6: a save whose scene is too large to sync is kept locally but never
  // pushed; surface it so the divergence is never silent.
  useEffect(() => {
    return onCanvasTooLarge((event) => {
      if (event.id === canvasId) {
        toast.error(t('canvas.tooLargeToSync'))
      }
    })
  }, [canvasId, t])

  const persisterRef = useRef<{ notifyChange: () => void } | null>(null)

  useEffect(() => {
    if (corrupt) {
      return
    }
    const persister = createScenePersister({
      serialize: () => {
        const api = apiRef.current
        if (!api) {
          return null
        }
        // Teardown guard: on an in-session unmount (tab switch / close), React
        // destroys the Excalidraw child BEFORE this parent's effect cleanup
        // runs its flush — at which point getSceneElements() returns [] and we
        // would serialize (and persist) an empty scene, wiping the real one.
        // The wrapper node is already detached from the document by then, so
        // treat a disconnected wrapper as "torn down, not readable" (the
        // serialize contract's null case). During normal saves and the
        // beforeunload/quit flush the wrapper is still connected, so those
        // persist as before.
        if (!wrapperRef.current?.isConnected) {
          return null
        }
        try {
          return serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')
        } catch (err) {
          log.error('Failed to serialize canvas scene', err)
          return null
        }
      },
      save: async (scene) => {
        // Advisory entity refs are derived from the same scene, so the dedupe
        // key (scene string) still governs whether a save runs.
        const elements = (apiRef.current?.getSceneElements() ?? []) as unknown as CardElement[]
        let sceneToSave = scene
        try {
          sceneToSave = await externalizeSceneAssets(scene, canvasId, (input) =>
            canvasService.uploadAsset(input)
          )
        } catch (err) {
          log.error('Failed to externalize canvas assets; saving scene as-is', err)
          // Fall back to the original scene — the pre-push size guard surfaces oversize saves.
        }
        await canvasService.update({
          id: canvasId,
          scene: sceneToSave,
          entityRefs: extractEntityRefs(elements)
        })
      },
      debounceMs: SCENE_SAVE_DEBOUNCE_MS,
      lastSavedScene: initialScene,
      onError: (err) => log.error('Failed to save canvas scene', err)
    })
    // PR #747 lesson: the debounce window must survive quit. The registry's
    // flush runs on the main process's app:request-flush handshake and on
    // beforeunload, so the last strokes are persisted before shutdown/reload.
    const registryKey = `canvas:${canvasId}`
    registerPendingSave(registryKey, () => persister.flush())
    persisterRef.current = persister
    return () => {
      unregisterPendingSave(registryKey)
      void persister.flush()
      persisterRef.current = null
    }
  }, [canvasId, initialScene, corrupt])

  // Excalidraw's own toolbar/menu i18n comes from its bundled translations via
  // langCode — independent of Memry's i18n and i18n:check; we do not translate
  // Excalidraw's internal UI ourselves.
  const langCode = useMemo(
    () => pickExcalidrawLangCode(getI18n().language, languages, defaultLang.code),
    []
  )

  if (corrupt) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <p className="text-sm text-destructive">{t('canvas.corruptScene')}</p>
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className="relative h-full w-full" data-canvas-editor={canvasId}>
      <Excalidraw
        excalidrawAPI={(instance) => {
          apiRef.current = instance
          setApi(instance)
        }}
        initialData={initialData}
        onChange={() => persisterRef.current?.notifyChange()}
        // Three Memry themes exist (light/dark/white); anything not dark maps
        // to Excalidraw's light theme.
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        langCode={langCode}
      />
      {api ? (
        <CanvasCardLayer
          excalidrawAPI={api}
          wrapperRef={wrapperRef}
          onSceneMutated={() => persisterRef.current?.notifyChange()}
        />
      ) : null}
    </div>
  )
}
