import { createContext } from 'react'

/**
 * True anywhere under a mounted `CanvasEditor`.
 *
 * A note shown on a canvas card renders its blocks with the note editor's own
 * schema, whiteboard blocks included, and a whiteboard mounts a `CanvasEditor`.
 * Left alone that nests without end: canvas A shows note N on a card, N embeds
 * board A, whose card shows N again. A whiteboard reads this and draws only
 * its header there, so the drawing is always one "Open in tab" away and never
 * a second live editor inside the first.
 *
 * Kept out of `canvas-editor.tsx` so the note editor can read it without
 * pulling the Excalidraw chunk into the main bundle.
 */
export const InsideCanvasSurfaceContext = createContext(false)
