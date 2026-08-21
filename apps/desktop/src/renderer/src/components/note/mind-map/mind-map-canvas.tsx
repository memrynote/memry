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
 */

import { useEffect, useRef } from 'react'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import '@excalidraw/excalidraw/index.css'
import { useTheme } from 'next-themes'
import type { MindMapElement } from './mind-map-types'

/**
 * The map's element descriptors are plain data so the pipeline that mints them
 * stays pure and testable without this chunk. Excalidraw's own skeleton type
 * brands its point tuples, which no plain literal can satisfy, so the handover
 * happens here, once, at the boundary.
 */
const toSkeleton = (elements: readonly MindMapElement[]): ExcalidrawElementSkeleton[] =>
  elements as unknown as ExcalidrawElementSkeleton[]

interface MindMapCanvasProps {
  elements: readonly MindMapElement[]
  /** The deep link of the box that was clicked. See `handleMindMapLinkOpen`. */
  onOpenLink: (href: string) => void
}

export function MindMapCanvas({ elements, onOpenLink }: MindMapCanvasProps): React.JSX.Element {
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
