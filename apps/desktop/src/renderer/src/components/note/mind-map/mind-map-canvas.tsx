/**
 * The Excalidraw-importing chunk of the mind map.
 *
 * Loaded lazily from `MindMapView` for the same reason `CanvasEditor` is loaded
 * lazily from `CanvasPage`: @excalidraw/excalidraw and its CSS stay out of the
 * main renderer bundle, and are never fetched by a user who never opens a map.
 * Fonts are self-hosted (see public/excalidraw-asset-path.js) because the CSP
 * blocks Excalidraw's CDN.
 *
 * Read-only by construction: the map is a derived view of the note, never a
 * document, so the surface is mounted in view mode and nothing here writes.
 *
 * The toolbar's actions are handed UP from here rather than reaching down,
 * because everything they need — the live scene and the export functions — is
 * inside this chunk, while the toolbar itself must render as a sibling of the
 * map's image region. (Anything inside an `img` role is presentational, so a
 * toolbar nested in it would be invisible to exactly the readers the accessible
 * projection exists for.)
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useTheme } from 'next-themes'
import { copySceneAsImage, copySceneAsVector, toSkeleton } from './mind-map-export'
import type { MindMapElement } from './mind-map-types'

/**
 * What the map's toolbar can do, closed over the live surface.
 *
 * Each copy rejects on failure rather than swallowing it — the host turns that
 * into something the user can read, so a failed export is never silent.
 */
export interface MindMapControls {
  /** Frame the whole drawing again, whatever the user panned or zoomed to. */
  fit: () => void
  copyImage: () => Promise<void>
  copyVector: () => Promise<void>
}

interface MindMapCanvasProps {
  elements: readonly MindMapElement[]
  /** The deep link of the box that was clicked. See `handleMindMapLinkOpen`. */
  onOpenLink: (href: string) => void
  /**
   * Called with the controls once the surface is live, and with `null` when it
   * goes away, so the toolbar is never wired to a surface that is not there.
   */
  onControlsChange?: (controls: MindMapControls | null) => void
}

export function MindMapCanvas({
  elements,
  onOpenLink,
  onControlsChange
}: MindMapCanvasProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)

  // Re-feeding the scene rather than remounting keeps the camera and the
  // library's own warm-up across a rebuild of the same note.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({ elements: convertToExcalidrawElements(toSkeleton(elements)) })
    api.scrollToContent(undefined, { fitToContent: true, animate: false })
  }, [elements])

  const fit = useCallback((): void => {
    apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: true })
  }, [])

  // Read through the ref at call time, never captured at build time: the point
  // of exporting from the live surface is that it holds whatever the map shows
  // right now, expanded branches included.
  const copyImage = useCallback(async (): Promise<void> => {
    const api = apiRef.current
    if (!api) return
    await copySceneAsImage(api)
  }, [])

  const copyVector = useCallback(async (): Promise<void> => {
    const api = apiRef.current
    if (!api) return
    await copySceneAsVector(api)
  }, [])

  const controls = useMemo<MindMapControls>(
    () => ({ fit, copyImage, copyVector }),
    [fit, copyImage, copyVector]
  )

  useEffect(() => {
    onControlsChange?.(controls)
    return () => onControlsChange?.(null)
  }, [controls, onControlsChange])

  return (
    <Excalidraw
      excalidrawAPI={(instance) => {
        apiRef.current = instance
      }}
      initialData={{
        elements: convertToExcalidrawElements(toSkeleton(elements)),
        appState: { viewBackgroundColor: 'transparent' },
        scrollToContent: true
      }}
      // In view mode the whole box is the link's hit area, so this fires for a
      // click anywhere on a node — which is what makes the drawing navigable at
      // all. The default must be prevented: Excalidraw's fallback ends in
      // `window.open`, which under Electron either does nothing or reloads the
      // entire app (see `canvas-editor.tsx`, same trap).
      onLinkOpen={(element, event) => {
        event.preventDefault()
        if (element.link) onOpenLink(element.link)
      }}
      viewModeEnabled
      zenModeEnabled
      UIOptions={{
        canvasActions: {
          export: false,
          loadScene: false,
          saveToActiveFile: false,
          changeViewBackgroundColor: false,
          clearCanvas: false,
          toggleTheme: false
        }
      }}
      // Three Memry themes exist (light/dark/white); anything not dark maps to
      // Excalidraw's light theme.
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
    />
  )
}
