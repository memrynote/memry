/**
 * CanvasEditor — the Excalidraw-importing chunk.
 *
 * Loaded lazily from CanvasPage so @excalidraw/excalidraw (and its CSS) stay
 * out of the main renderer bundle. Fonts are self-hosted (see
 * public/excalidraw-asset-path.js) because the CSP blocks Excalidraw's CDN.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Excalidraw,
  serializeAsJSON,
  languages,
  defaultLang,
  useHandleLibrary,
  CaptureUpdateAction
} from '@excalidraw/excalidraw'
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
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { createScenePersister } from './canvas-persistence'
import { externalizeSceneAssets } from './canvas-externalize'
import { pickExcalidrawLangCode } from './excalidraw-lang'
import { CanvasCardLayer } from './canvas-card-overlay'
import { createVaultLibraryAdapter } from './canvas-library-adapter'
import { extractEntityRefs, type CardElement } from './canvas-cards'
import {
  registerLiveCanvas,
  unregisterLiveCanvas,
  type LiveCanvasHandle
} from './canvas-live-registry'
import type { SceneEditElement } from './canvas-scene-edit'

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

  const persisterRef = useRef<{ notifyChange: () => void; flush: () => Promise<void> } | null>(null)

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
        // Init guard: Excalidraw applies initialData asynchronously after
        // mount (componentDidMount → initializeScene). Until that resolves,
        // getSceneElements() returns [] while appState.isLoading is true —
        // and the isConnected guard above does not cover this window (e.g.
        // StrictMode's simulated remount runs this effect's cleanup flush
        // with the wrapper still attached). Serializing here would persist
        // an empty scene over the stored one, so treat a still-loading
        // scene as not readable.
        if (api.getAppState().isLoading) {
          return null
        }
        try {
          return serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')
        } catch (err) {
          log.error('Failed to serialize canvas scene', err)
          trackRendererError('canvas_scene_serialize', err)
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
          trackRendererError('canvas_asset_externalize', err)
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
      onError: (err) => {
        log.error('Failed to save canvas scene', err)
        // The persister keeps the change pending and retries, but a failing
        // save is silent data loss in the making — it must reach telemetry.
        trackRendererError('canvas_scene_save', err)
      }
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

  // Agent MCP writes to THIS canvas must reach this live instance rather than a
  // headless read-modify-write, or our next autosave overwrites them (#916 §2e).
  // Main is told which window owns the canvas so it can route the write here.
  useEffect(() => {
    if (!api || corrupt) return

    const handle: LiveCanvasHandle = {
      getElements: () => api.getSceneElements() as unknown as SceneEditElement[],
      updateScene: (elements) => {
        api.updateScene({
          elements: elements as never,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      },
      flush: async () => {
        await persisterRef.current?.flush()
      }
    }
    registerLiveCanvas(canvasId, handle)
    void window.api.canvas.liveOpened(canvasId)

    return () => {
      unregisterLiveCanvas(canvasId, handle)
      void window.api.canvas.liveClosed(canvasId)
    }
  }, [api, canvasId, corrupt])

  // The library is vault-global, not per canvas: Excalidraw keeps one shared
  // collection, and this editor remounts per canvas id, so anything held in
  // component state would be lost on the next tab switch. The adapter is
  // rebuilt per mount but reads from the vault, so that remount is harmless.
  const libraryAdapter = useMemo(
    () =>
      createVaultLibraryAdapter({
        list: () => canvasService.libraryList(),
        save: (libraryItems) => canvasService.librarySave(libraryItems),
        onError: (err, operation) => {
          log.error(`Failed to ${operation} canvas library`, err)
          trackRendererError(`canvas_library_${operation}`, err)
          if (operation === 'save') {
            // A failed load leaves the panel as-is and retries on the next
            // save; a failed save means the user's import is not on disk, so
            // only that one is worth interrupting them for.
            toast.error(t('canvas.libraryStoreFailed'))
          }
        }
      }),
    [t]
  )

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter })

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

  // Cmd/Ctrl+S (and Cmd/Ctrl+Shift+S) would reach Excalidraw's document-level
  // keydown listener and open its save-to-disk file dialog — file semantics
  // that don't exist here: the scene autosaves into the vault. Intercept in
  // the capture phase (Excalidraw listens on document in the bubble phase),
  // flush any pending change, and confirm the autosave instead.
  const handleKeyDownCapture = (event: React.KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      void persisterRef.current?.flush()
      toast.success(t('canvas.savedToVault'))
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      data-canvas-editor={canvasId}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <Excalidraw
        excalidrawAPI={(instance) => {
          apiRef.current = instance
          setApi(instance)
        }}
        initialData={initialData}
        // The vault is the only store: hide Excalidraw's own file actions
        // (open .excalidraw, save to disk) so they can't bypass — or, via
        // loadScene, silently replace — the vault-persisted scene.
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false
          }
        }}
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
