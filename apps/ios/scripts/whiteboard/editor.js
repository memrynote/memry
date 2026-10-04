// The page behind WhiteboardEditor.swift: desktop's Excalidraw, full screen,
// reading and writing one canvas scene. Bundled by generate-whiteboard.mjs.
//
// Swift calls `memryBoard.open(scene, dark)` once the page loads, then
// `memryBoard.flush()` on Done. The page posts `{ kind: "ready" }` once the
// scene is on screen and `{ kind: "scene", scene }` after each edit settles.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

const SAVE_DEBOUNCE_MS = 800

const post = (message) => window.webkit?.messageHandlers?.board?.postMessage(message)

/**
 * `serializeAsJSON` writes only what Excalidraw knows. Desktop's main process
 * adds top-level keys of its own (the `memryAssets` sidecar a receiving device
 * restores externalized images from), so every key the stored scene had that
 * the serialized one lacks is carried over unchanged.
 */
function withStoredKeys(serialized, stored) {
  const scene = JSON.parse(serialized)
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in scene)) scene[key] = value
  }
  return scene
}

/**
 * An image desktop externalized (`memry-file://`) cannot load here, and
 * Excalidraw marks it `status: "error"` when it fails. That is this device's
 * view, not the image's state, so the stored status goes back on.
 */
function withStoredImageStatus(scene, statuses) {
  for (const element of scene.elements ?? []) {
    if (element.type === 'image' && element.status === 'error' && statuses.has(element.id)) {
      element.status = statuses.get(element.id)
    }
  }
  return scene
}

let api = null
let stored = {}
let imageStatuses = new Map()
let baseline = null
let touched = false
let timer = null

function serialize() {
  if (!api || api.getAppState().isLoading) return null
  const scene = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')
  return JSON.stringify(withStoredImageStatus(withStoredKeys(scene, stored), imageStatuses))
}

/**
 * The scene when it differs from what was loaded or last saved, else null.
 * Nothing is written until a finger or key has touched the board: opening a
 * board re-measures its text and settles its images, and those changes are
 * Excalidraw's, not the user's, so a board only looked at is never rewritten.
 */
function pending() {
  if (!touched) return null
  const scene = serialize()
  if (scene === null || scene === baseline) return null
  baseline = scene
  return scene
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const scene = pending()
    if (scene !== null) post({ kind: 'scene', scene })
  }, SAVE_DEBOUNCE_MS)
}

window.memryBoard = {
  open(sceneJson, dark) {
    const parsed = sceneJson ? JSON.parse(sceneJson) : {}
    const { elements, appState, files, ...rest } = parsed
    stored = rest
    imageStatuses = new Map(
      (elements ?? []).filter((e) => e.type === 'image' && e.status).map((e) => [e.id, e.status])
    )
    for (const event of ['pointerdown', 'keydown']) {
      document.addEventListener(event, () => (touched = true), { capture: true })
    }
    createRoot(document.getElementById('root')).render(
      createElement(Excalidraw, {
        initialData: { elements: elements ?? [], appState: appState ?? {}, files, scrollToContent: true },
        excalidrawAPI: (value) => (api = value),
        theme: dark ? 'dark' : 'light',
        // The vault is the only store, as on desktop. The image tool is off:
        // this device cannot externalize an image, and an inline one would
        // ride every sync of the board.
        UIOptions: {
          canvasActions: { export: false, loadScene: false, saveToActiveFile: false },
          tools: { image: false }
        },
        onChange: () => {
          if (!api || api.getAppState().isLoading) return
          if (baseline === null) {
            baseline = serialize()
            post({ kind: 'ready' })
            return
          }
          schedule()
        }
      })
    )
  },
  /** The unsaved scene, or null when there is nothing to save. */
  flush() {
    clearTimeout(timer)
    return pending()
  },
  /** The whole scene as it would be saved, for the round-trip test. */
  serialize() {
    return serialize()
  }
}
