/**
 * Taking the map with you.
 *
 * Part of the lazy drawing chunk: it imports @excalidraw/excalidraw, so it is
 * only ever reached from `mind-map-canvas.tsx` and never from a module the main
 * renderer bundle can see.
 *
 * The scene comes from the LIVE surface, never from a fresh `buildMindMap`
 * call. What the user copies has to be what the user is looking at — including
 * branches they expanded — and only the surface knows that.
 *
 * Both paths go through `navigator.clipboard`, which is the app's existing
 * clipboard convention, and both stay inside the `clipboard-sanitized-write`
 * permission the session already grants (see `main/session-permissions.ts`):
 *
 * - The image is a PNG `ClipboardItem`. PNG is one of the clipboard's
 *   well-known sanitized types, so no unsanitized-write permission is needed.
 * - The vector is the SVG *markup*, written as text. `image/svg+xml` is not a
 *   sanitized clipboard type, and asking for raw clipboard access to carry it
 *   would mean widening a deny-by-default permission set for one button. Design
 *   tools read pasted SVG markup, and the drawing library's own "copy as SVG"
 *   does exactly this.
 *
 * Neither path needs a main-process channel, so no IPC contract is touched.
 */

import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/** The slice of the live surface an export reads. */
export type MindMapSceneSource = Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getFiles'>

/** Breathing room around the drawing, in scene units. */
const EXPORT_PADDING = 16

/**
 * The export settings, pinned rather than inherited from the live surface.
 *
 * The map's colours are authored for a light surface (see
 * `mind-map-elements.ts`), so exporting in dark mode would hand the user an
 * image that does not match what any other reader sees. A transparent
 * background lets the result drop into a note, a message or a slide without
 * carrying a rectangle of the app's own background colour with it. Two pixels
 * per scene unit keeps a pasted map crisp on a high-density display.
 *
 * Nothing here reads the camera, so panning or zooming the map does not change
 * what a copy contains: the export is the whole drawing, every time.
 */
const EXPORT_APP_STATE = {
  exportBackground: false,
  exportWithDarkMode: false,
  exportEmbedScene: false,
  exportScale: 2
} as const

/** The map as currently drawn, on the clipboard as a PNG. */
export async function copySceneAsImage(source: MindMapSceneSource): Promise<void> {
  const blob = await exportToBlob({
    elements: source.getSceneElements(),
    appState: EXPORT_APP_STATE,
    files: source.getFiles(),
    exportPadding: EXPORT_PADDING,
    mimeType: 'image/png'
  })

  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/** The map as currently drawn, on the clipboard as SVG markup. */
export async function copySceneAsVector(source: MindMapSceneSource): Promise<void> {
  const svg = await exportToSvg({
    elements: source.getSceneElements(),
    appState: EXPORT_APP_STATE,
    files: source.getFiles(),
    exportPadding: EXPORT_PADDING
  })

  await navigator.clipboard.writeText(svg.outerHTML)
}
