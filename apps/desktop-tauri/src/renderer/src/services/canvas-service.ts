/**
 * Canvas Service
 *
 * The canvas commands (`commands/canvas.rs`) in the shapes of Electron's `canvas:*` channels.
 */

import type {
  Canvas as ElectronCanvas,
  CanvasSummary,
  CanvasClientAPI,
  CanvasCreateInput,
  CanvasUpdateInput as ElectronCanvasUpdateInput,
  CanvasUpdateResponse as ElectronCanvasUpdateResponse,
  CanvasCreatedEvent,
  CanvasUpdatedEvent,
  CanvasDeletedEvent,
  CanvasTooLargeEvent,
  CanvasLibraryListResponse
} from '@memry/rpc/canvas'
import { commands, events, type CanvasView, type Value } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

export type { CanvasSummary }

/**
 * A canvas with the sha256 of the document bytes this reader got (`null`: none). Each reader
 * keeps its own and sends it back as `expectedSha256`, so a save over bytes it never saw keeps
 * them as a conflict copy instead of overwriting them.
 */
export type Canvas = ElectronCanvas & { sha256: string | null }
export type CanvasUpdateInput = ElectronCanvasUpdateInput & { expectedSha256?: string | null }
/** `sha256`: the document after the save, the saver's next `expectedSha256`. */
export type CanvasUpdateResponse = ElectronCanvasUpdateResponse & { sha256: string | null }

type CanvasApi = Omit<CanvasClientAPI, 'create' | 'get' | 'update'> & {
  create: (input?: CanvasCreateInput) => Promise<Canvas>
  get: (id: string) => Promise<Canvas | null>
  update: (input: CanvasUpdateInput) => Promise<CanvasUpdateResponse>
}

/** `unreadable` is set only for a document linked out of the vault, as in Electron. */
function toCanvas({ unreadable, ...canvas }: CanvasView): Canvas {
  return unreadable ? { ...canvas, unreadable } : canvas
}

export const canvasService: CanvasApi = {
  create: async (input = {}) => toCanvas(await commands.canvasCreate(input)),
  get: async (id) => {
    const view = await commands.canvasGet(id)
    return view ? toCanvas(view) : null
  },
  // The entity refs are derived from the scene by main; the command takes none.
  update: ({ entityRefs: _entityRefs, ...input }) => commands.canvasUpdate(input),
  delete: (id) => commands.canvasDelete(id),
  list: () => commands.canvasList(),
  duplicate: (id) => commands.canvasDuplicate(id),
  revealInFinder: async (id) => {
    await commands.canvasRevealInFinder(id)
  },
  openExternal: async (id) => {
    await commands.canvasOpenExternal(id)
  },
  // A library item is Excalidraw's JSON as is; main refuses one without a string id.
  libraryList: async () =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- items main wrote from CanvasLibraryItemSchema, carried as JSON
    (await commands.canvasLibraryList()) as CanvasLibraryListResponse,
  librarySave: (libraryItems) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an item is JSON the command carries as is
    commands.canvasLibrarySave({ libraryItems: libraryItems as Value[] }),
  // Electron's invoke shape: the image bytes as a number array.
  uploadAsset: ({ data, ...input }) =>
    commands.canvasUploadAsset({ ...input, data: Array.from(new Uint8Array(data)) }),
  canUploadAsset: () => commands.canvasCanUploadAsset(),
  getAsset: (canvasId, fileId) => commands.canvasGetAsset(canvasId, fileId),
  listAssets: (canvasId) => commands.canvasListAssets(canvasId),
  liveOpened: (canvasId) => commands.canvasLiveOpened(canvasId),
  liveClosed: (canvasId) => commands.canvasLiveClosed(canvasId)
} satisfies CanvasApi

export function onCanvasCreated(callback: (event: CanvasCreatedEvent) => void): () => void {
  return subscribeToEvent(events.canvasCreatedEvent, callback)
}

export function onCanvasUpdated(callback: (event: CanvasUpdatedEvent) => void): () => void {
  return subscribeToEvent(events.canvasUpdatedEvent, callback)
}

export function onCanvasDeleted(callback: (event: CanvasDeletedEvent) => void): () => void {
  return subscribeToEvent(events.canvasDeletedEvent, callback)
}

export function onCanvasTooLarge(callback: (event: CanvasTooLargeEvent) => void): () => void {
  return subscribeToEvent(events.canvasTooLargeEvent, callback)
}
