/**
 * CanvasEditor — the Excalidraw-importing chunk.
 *
 * Loaded lazily from CanvasPage so @excalidraw/excalidraw (and its CSS) stay
 * out of the main renderer bundle. Fonts are self-hosted (see
 * public/excalidraw-asset-path.js) because the CSP blocks Excalidraw's CDN.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { useTabActions } from '@/contexts/tabs'
import { useTabEntityViewState } from '@/hooks/use-tab-entity-view-state'
import { parseMemryHref, tabFromMemryHref } from '@/lib/memry-links'
import { notesService } from '@/services/notes-service'
import { canvasService, onCanvasTooLarge } from '@/services/canvas-service'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { CanvasLinkDialog } from './canvas-link-dialog'
import {
  elementLinkTarget,
  truncateLabel,
  HYPERLINK_ANCHOR_SELECTOR,
  linkBubbleLabel,
  type LabelElement
} from './canvas-link-label'
import { lookupCardTitle } from './canvas-link-target-title'
import { resolveCanvasLink } from './canvas-link-open'
import { computeSceneSignature, createScenePersister } from './canvas-persistence'
import { externalizeSceneAssets, retryCanvasAssetUploads } from './canvas-externalize'
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
import {
  CANVAS_VIEWPORT_KEY,
  parseCanvasViewport,
  sameViewport,
  viewportFromAppState,
  type CanvasViewport,
  type ViewportAppState
} from './canvas-viewport'

const log = createLogger('SpatialCanvas')

const SCENE_SAVE_DEBOUNCE_MS = 800
/**
 * How often the camera is committed to tab state while the user pans or zooms.
 * Excalidraw's onChange fires per frame, and every commit mints a new
 * tab-system state object and re-renders every `useTabGroup` consumer.
 */
const VIEWPORT_SAVE_THROTTLE_MS = 500

/**
 * The appState slice that positions the camera.
 *
 * Cast because `zoom` is typed as a branded `NormalizedZoomValue` that the
 * library does not export a constructor for. The number is Excalidraw's own,
 * round-tripped through tab state, and `parseCanvasViewport` has already held it
 * to the library's range.
 */
const viewportAppState = (
  viewport: CanvasViewport
): NonNullable<ExcalidrawInitialDataState['appState']> =>
  ({
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    zoom: { value: viewport.zoom }
  }) as NonNullable<ExcalidrawInitialDataState['appState']>

/** A scene element as this file reads it: cards carry `customData`. */
interface LinkableElement {
  id: string
  customData?: { entityType?: string } | null
}

interface CanvasEditorProps {
  canvasId: string
  /** Serialized scene as stored (serializeAsJSON output), '' when never drawn on. */
  initialScene: string
}

export const CanvasEditor = ({ canvasId, initialScene }: CanvasEditorProps): React.JSX.Element => {
  const { t } = useT('common')
  const { resolvedTheme } = useTheme()
  const { openTab } = useTabActions()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null)
  /** Latched while Excalidraw's own link editor is being intercepted. */
  const linkEditorHandledRef = useRef(false)
  /** Card titles already resolved for the link bubble, so relabels are stable. */
  const cardTitles = useRef(new Map<string, string>())

  // Parse the stored scene up front only to decide whether it is loadable —
  // and deliberately throw the parsed graph away. Retaining it (as a useMemo
  // did) kept a second full copy of the scene, inline image data URLs and all,
  // alive for as long as the tab was open. Excalidraw accepts a function for
  // initialData and calls it once from componentDidMount, so the real parse
  // happens there and becomes garbage as soon as Excalidraw has restored it
  // into its own objects. The cost is one extra parse per canvas open; the
  // saving is a multi-MB copy per open canvas.
  const corrupt = useMemo(() => {
    if (!initialScene) {
      return false
    }
    try {
      JSON.parse(initialScene)
      return false
    } catch (err) {
      log.error('Failed to parse stored canvas scene; refusing to mount editor', err)
      return true
    }
  }, [initialScene])

  // Where this TAB was last looking. Stored per tab rather than in the scene:
  // the scene's exported appState carries no viewport at all (see
  // `canvas-viewport.ts`), and two split panes on one canvas are two cameras.
  const [storedViewport, setStoredViewport] = useTabEntityViewState<CanvasViewport | null>({
    key: CANVAS_VIEWPORT_KEY,
    defaultValue: null,
    parse: parseCanvasViewport
  })
  /**
   * Mount-time snapshot of that camera. `initialData` is read once, from
   * componentDidMount, so reading the live value inside `loadInitialData` would
   * only churn the callback's identity on every write we make ourselves.
   */
  const restoredViewportRef = useRef(storedViewport)
  /** Live camera, mirrored out of onChange. The only thing teardown may persist. */
  const viewportRef = useRef(storedViewport)
  /** Last camera actually written, so a commit that changes nothing is skipped. */
  const committedViewportRef = useRef(storedViewport)
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setStoredViewportRef = useRef(setStoredViewport)

  useLayoutEffect(() => {
    setStoredViewportRef.current = setStoredViewport
  }, [setStoredViewport])

  const commitViewport = useCallback((): void => {
    viewportTimerRef.current = null
    const next = viewportRef.current
    if (next === null || sameViewport(next, committedViewportRef.current)) {
      return
    }
    committedViewportRef.current = next
    setStoredViewportRef.current(next)
  }, [])

  /**
   * Mirrors the camera out of onChange, throttled.
   *
   * Ignored while `isLoading`: Excalidraw fires onChange during init carrying
   * its default appState (origin, 100%), and recording that would overwrite the
   * stored camera with the origin before initialData has even been applied —
   * the same init-window hazard the serialize guard below exists for.
   */
  const recordViewport = useCallback(
    (appState: ViewportAppState & { isLoading?: boolean }): void => {
      if (appState.isLoading) {
        return
      }
      const next = viewportFromAppState(appState)
      if (!next) {
        return
      }
      viewportRef.current = next
      if (viewportTimerRef.current === null) {
        viewportTimerRef.current = setTimeout(commitViewport, VIEWPORT_SAVE_THROTTLE_MS)
      }
    },
    [commitViewport]
  )

  // Final write at teardown, from the REF — never from the API. On a tab switch
  // React destroys the Excalidraw child before this parent's cleanup runs, so by
  // then `getAppState()` describes a torn-down editor; that is the same reason
  // the serialize path checks `wrapperRef.isConnected`.
  useEffect(() => {
    return () => {
      if (viewportTimerRef.current !== null) {
        clearTimeout(viewportTimerRef.current)
        viewportTimerRef.current = null
      }
      commitViewport()
    }
  }, [commitViewport])

  const loadInitialData = useCallback((): ExcalidrawInitialDataState | null => {
    const viewport = restoredViewportRef.current
    if (!initialScene) {
      // Never drawn on — but the user may still have panned or zoomed here, and
      // an empty canvas is the easiest place of all to get lost in.
      return viewport
        ? ({
            elements: [],
            appState: viewportAppState(viewport),
            scrollToContent: false
          } satisfies ExcalidrawInitialDataState)
        : null
    }
    // serializeAsJSON output: { elements, appState, files } plus metadata
    // keys initialData ignores. Its exported appState is already cleaned
    // (no volatile keys, no collaborators), so it restores as-is. Corruption
    // was already ruled out above, so a throw here cannot happen — but if it
    // ever did, Excalidraw catches it and surfaces its own error message
    // rather than mounting a silently empty scene.
    const parsed = JSON.parse(initialScene) as ExcalidrawInitialDataState
    return {
      elements: parsed.elements ?? [],
      appState: { ...(parsed.appState ?? {}), ...(viewport ? viewportAppState(viewport) : {}) },
      files: parsed.files,
      // `scrollToContent` runs AFTER the appState restore and would undo it, so
      // it stays the fallback for a tab that has no camera of its own yet.
      scrollToContent: viewport === null
    } satisfies ExcalidrawInitialDataState
  }, [initialScene])

  // An image whose upload failed is not re-attempted on the very next save
  // (see canvas-externalize); a change in sync state — auth restored, network
  // back, sync resumed — is what makes it worth trying again. Subscribed
  // directly rather than through useSync so a sync tick does not re-render
  // this editor.
  useEffect(() => window.api.onSyncStatusChanged(() => retryCanvasAssetUploads()), [])

  // §5.6: a save whose scene is too large to sync is kept locally but never
  // pushed; surface it so the divergence is never silent.
  //
  // The signal fires on EVERY oversized save, and the scene is auto-saved
  // whenever anything on the canvas moves — so announcing it per event buried
  // the user under an endless stack of identical toasts while they worked
  // (#1625/C2). The announcement is therefore edge-triggered: once when the
  // canvas stops syncing, re-armed only after a save syncs again. The stable
  // toast id is the second line of defence — sonner replaces rather than
  // stacks, so even a repeat announcement can never pile up.
  const tooLargeAnnouncedRef = useRef(false)
  const announceSyncability = useCallback(
    (tooLarge: boolean): void => {
      if (!tooLarge) {
        tooLargeAnnouncedRef.current = false
        return
      }
      if (tooLargeAnnouncedRef.current) {
        return
      }
      tooLargeAnnouncedRef.current = true
      toast.error(t('canvas.tooLargeToSync'), { id: `canvas-too-large-${canvasId}` })
    },
    [canvasId, t]
  )
  // The persister's save closure is built once per canvas, so it reads the
  // announcer through a ref rather than re-creating the persister on every
  // language change.
  const announceSyncabilityRef = useRef(announceSyncability)
  useEffect(() => {
    announceSyncabilityRef.current = announceSyncability
  }, [announceSyncability])

  useEffect(() => {
    return onCanvasTooLarge((event) => {
      if (event.id === canvasId) {
        announceSyncabilityRef.current(true)
      }
    })
  }, [canvasId])

  const persisterRef = useRef<{ notifyChange: () => void; flush: () => Promise<void> } | null>(null)

  useEffect(() => {
    if (corrupt) {
      return
    }
    // Shared by serialize and signature so a readable-scene check can never
    // drift between them: a signature taken from a scene the serializer would
    // refuse to read must not advance the dedupe baseline.
    const readableApi = (): ExcalidrawImperativeAPI | null => {
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
      return api
    }

    const persister = createScenePersister({
      // Cheap gate in front of the serialize below: onChange fires for pan and
      // zoom too, and without this every 800 ms of idle panning paid a full
      // serializeAsJSON (inline image data URLs included) just to discover the
      // string was unchanged. Null on any failure — never "unchanged".
      signature: () => {
        const api = readableApi()
        if (!api) {
          return null
        }
        try {
          return computeSceneSignature({
            elements: api.getSceneElements(),
            files: api.getFiles(),
            // serializeAsJSON exports only a few appState keys; running it
            // over an empty scene yields exactly those, without paying for
            // elements or files.
            appStateJson: serializeAsJSON([], api.getAppState(), {}, 'local')
          })
        } catch (err) {
          log.error('Failed to fingerprint canvas scene; falling back to a full serialize', err)
          return null
        }
      },
      serialize: () => {
        const api = readableApi()
        if (!api) {
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
          sceneToSave = await externalizeSceneAssets(
            scene,
            canvasId,
            (input) => canvasService.uploadAsset(input),
            // One cheap question per save, ahead of any image bytes: a
            // signed-out or sync-less device keeps its images inline instead
            // of failing an upload per image per save (#1581).
            { canUpload: async () => (await canvasService.canUploadAsset()).canUpload }
          )
        } catch (err) {
          log.error('Failed to externalize canvas assets; saving scene as-is', err)
          trackRendererError('canvas_asset_externalize', err)
          // Fall back to the original scene — the pre-push size guard surfaces oversize saves.
        }
        const saved = await canvasService.update({
          id: canvasId,
          scene: sceneToSave,
          entityRefs: extractEntityRefs(elements)
        })
        // The only signal that carries BOTH edges: the too-large event fires
        // for oversized saves only, so a save that syncs again is what re-arms
        // the announcement above.
        announceSyncabilityRef.current(saved.tooLarge)
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

  /**
   * Excalidraw's link bubble prints `element.link` verbatim, so a link to a note
   * reads as `memry://note/s5b2qadr6tg4`. There is no prop to change what it
   * renders, so the text is swapped in place once the bubble appears, using the
   * title the href carries. If Excalidraw ever renames that class the swap stops
   * happening and the URL shows again — the pre-existing behaviour, not a break.
   */
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || corrupt || typeof MutationObserver === 'undefined') return

    const setText = (anchor: HTMLAnchorElement, label: string): void => {
      if (anchor.isConnected && anchor.textContent !== label) {
        anchor.textContent = label
      }
    }

    const relabel = (): void => {
      for (const anchor of wrapper.querySelectorAll<HTMLAnchorElement>(HYPERLINK_ANCHOR_SELECTOR)) {
        // `href` is resolved by the DOM (and a custom scheme survives it); the
        // attribute is what Excalidraw actually wrote.
        const href = anchor.getAttribute('href')
        const label = linkBubbleLabel(href)
        if (label) {
          setText(anchor, label)
          continue
        }

        // An element link ("link to object") reads as the app's own URL with
        // ?element=<id>. Excalidraw elements have no name, so the target is
        // read out of the live scene instead: a card is named by the item it
        // shows, a shape by the text on it.
        const action = resolveCanvasLink(href, window.location.href)
        if (action.kind !== 'element') {
          continue
        }
        const elements = (apiRef.current?.getSceneElements() ?? []) as unknown as LabelElement[]
        const target = elementLinkTarget(action.elementId, elements)

        if (target.kind === 'text') {
          setText(anchor, truncateLabel(target.text))
          continue
        }
        if (target.kind === 'shape') {
          setText(anchor, t('canvas.link.shapeTarget'))
          continue
        }
        if (target.kind === 'missing') {
          setText(anchor, t('canvas.link.missingTarget'))
          continue
        }
        // A card costs one read. Writing a placeholder first and the title
        // second would feed this observer its own mutation forever (placeholder
        // → title → relabel → placeholder → …), so nothing is written until the
        // title is known, and it is remembered so every later relabel writes
        // the SAME text and the loop terminates.
        const cardKey = `${target.entityType}:${target.entityId}`
        const known = cardTitles.current.get(cardKey)
        if (known) {
          setText(anchor, known)
          continue
        }
        void lookupCardTitle(target.entityType, target.entityId).then((title) => {
          if (!title) return
          cardTitles.current.set(cardKey, truncateLabel(title))
          setText(anchor, truncateLabel(title))
        })
      }
    }

    relabel()
    const observer = new MutationObserver(relabel)
    observer.observe(wrapper, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [corrupt, t])

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

  /**
   * Opens the vault item a `memry://` link points at.
   *
   * Kinds that get a tab of their own (a note, a filed binary) are read first:
   * the item may have been deleted since the link was drawn, and a note tab
   * whose entity is gone opens blank with no way back to what went wrong. The
   * singleton views (Tasks, Inbox, Calendar) open regardless of whether their
   * focus target still exists, so they are not worth the round trip.
   */
  const openMemryTarget = useCallback(
    async (href: string): Promise<void> => {
      const parsed = parseMemryHref(href)
      if (!parsed) return

      let title: string | undefined
      if (parsed.kind === 'note' || parsed.kind === 'file') {
        const item =
          parsed.kind === 'file'
            ? await notesService.getFile(parsed.id).catch(() => null)
            : await notesService.get(parsed.id).catch(() => null)
        if (!item) {
          toast.error(t('canvas.link.itemMissing'))
          return
        }
        title = item.title
      }

      const tab = tabFromMemryHref(href, { title, now: Date.now() })
      if (!tab) {
        toast.error(t('canvas.link.itemMissing'))
        return
      }
      openTab(tab)
    },
    [openTab, t]
  )

  /**
   * Every link click on this canvas is ours. Excalidraw's fallback ends in
   * `window.open(undefined, target)` + `newWindow.location = url`, which under
   * Electron either does nothing at all (the real URL never reaches the
   * main-process allowlist, so `newWindow` is null) or — for its own element
   * links, when `isLocalLink` matches — assigns `window.location` and reloads
   * the entire app. Preventing the event's default is what disables both.
   */
  const handleLinkOpen = useCallback<
    NonNullable<React.ComponentProps<typeof Excalidraw>['onLinkOpen']>
  >(
    (element, event) => {
      event.preventDefault()
      const action = resolveCanvasLink(element.link, window.location.href)

      switch (action.kind) {
        case 'memry':
          void openMemryTarget(action.href)
          return
        case 'element': {
          const api = apiRef.current
          if (!api) return
          const target = api.getSceneElements().find((el) => el.id === action.elementId)
          if (!target) {
            toast.error(t('canvas.link.elementMissing'))
            return
          }
          api.scrollToContent(target, { fitToContent: true, animate: true })
          api.updateScene({
            appState: { selectedElementIds: { [action.elementId]: true } },
            captureUpdate: CaptureUpdateAction.EVENTUALLY
          })
          return
        }
        case 'external':
          // `_blank` is what reaches setWindowOpenHandler, whose allowlist is
          // the single gate on which schemes may leave the app.
          window.open(action.url, '_blank', 'noopener,noreferrer')
          return
        case 'ignore':
          return
      }
    },
    [openMemryTarget, t]
  )

  /**
   * Opens the "Link to item" picker for the current selection.
   *
   * Exactly one shape must be selected: a link lives on a single element, and
   * silently picking one out of several would attach it somewhere the user did
   * not look. Memry cards are excluded — a card already opens its own entity,
   * so a second, possibly different, link on it is a contradiction.
   */
  const openLinkPicker = useCallback((): void => {
    const api = apiRef.current
    if (!api) return

    const selectedIds = Object.entries(api.getAppState().selectedElementIds)
      .filter(([, selected]) => selected)
      .map(([id]) => id)

    if (selectedIds.length !== 1) {
      toast.error(t('canvas.link.selectOneShape'))
      return
    }

    const element = api.getSceneElements().find((el) => el.id === selectedIds[0]) as
      LinkableElement | undefined
    if (!element) {
      toast.error(t('canvas.link.selectOneShape'))
      return
    }
    if (element.customData?.entityType) {
      toast.error(t('canvas.link.cardsCannotLink'))
      return
    }

    setLinkTargetId(element.id)
    setLinkPickerOpen(true)
  }, [t])

  /** Writes the chosen item's href onto the shape the picker was opened for. */
  const applyLink = useCallback(
    (href: string): void => {
      const api = apiRef.current
      const targetId = linkTargetId
      if (!api || !targetId) return

      const elements = api.getSceneElements()
      if (!elements.some((el) => el.id === targetId)) {
        // Deleted while the picker was open.
        toast.error(t('canvas.link.elementMissing'))
        return
      }

      api.updateScene({
        elements: elements.map((el) => (el.id === targetId ? { ...el, link: href } : el)) as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      // updateScene does not run the editor's onChange, so the persister has to
      // be told or the link would sit unsaved until the next unrelated edit.
      persisterRef.current?.notifyChange()
      toast.success(t('canvas.link.linked'))
    },
    [linkTargetId, t]
  )

  /**
   * Excalidraw's own "Create link" action — the chain button under Actions, and
   * Cmd/Ctrl+K — only knows how to take a typed address. It works by setting
   * `appState.showHyperlinkPopup` to "editor", which reaches us through
   * onChange, so the button can be answered with our item picker instead of
   * its URL box without touching Excalidraw's DOM.
   *
   * Its "info" popup is left alone: that is where an existing link's edit and
   * remove buttons live, and removing a link stays Excalidraw's job.
   */
  const interceptLinkEditor = useCallback(
    (appState: { showHyperlinkPopup: false | 'info' | 'editor' }): void => {
      if (appState.showHyperlinkPopup !== 'editor') {
        linkEditorHandledRef.current = false
        return
      }
      // onChange fires repeatedly while the popup is open; act once per opening.
      if (linkEditorHandledRef.current) return
      linkEditorHandledRef.current = true

      apiRef.current?.updateScene({
        appState: { showHyperlinkPopup: false },
        captureUpdate: CaptureUpdateAction.NEVER
      })
      openLinkPicker()
    },
    [openLinkPicker]
  )

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
      return
    }
    // Cmd/Ctrl+Shift+K opens the item picker for the selected shape. Caught in
    // the capture phase for the same reason Cmd+S is: Excalidraw listens on
    // document and would otherwise act on the key first.
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === 'k' &&
      !event.altKey
    ) {
      event.preventDefault()
      event.stopPropagation()
      openLinkPicker()
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
        initialData={loadInitialData}
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
        onChange={(_elements, appState) => {
          persisterRef.current?.notifyChange()
          recordViewport(appState)
          interceptLinkEditor(appState)
        }}
        onLinkOpen={handleLinkOpen}
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
      <CanvasLinkDialog
        open={linkPickerOpen}
        onOpenChange={setLinkPickerOpen}
        onPick={(href) => applyLink(href)}
      />
    </div>
  )
}
