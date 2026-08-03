import { z } from 'zod'
import { CanvasChannels } from '../../contracts/src/ipc-channels.ts'
import {
  CanvasCreateSchema,
  CanvasUpdateSchema,
  type Canvas,
  type CanvasLibraryItem,
  type CanvasLibraryListResponse,
  type CanvasLibrarySaveResponse,
  type CanvasSummary,
  type CanvasUpdateResponse,
  type CanvasEntityRef,
  type CanvasListResponse,
  type CanvasDeleteResponse,
  type CanvasUploadAssetResponse,
  type CanvasGetAssetResponse,
  type CanvasListAssetsResponse,
  type CanvasCreatedEvent,
  type CanvasUpdatedEvent,
  type CanvasDeletedEvent,
  type CanvasTooLargeEvent
} from '../../contracts/src/canvas-api.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export type CanvasCreateInput = z.input<typeof CanvasCreateSchema>
export type CanvasUpdateInput = z.input<typeof CanvasUpdateSchema>

export type {
  Canvas,
  CanvasSummary,
  CanvasUpdateResponse,
  CanvasEntityRef,
  CanvasListResponse,
  CanvasDeleteResponse,
  CanvasLibraryItem,
  CanvasLibraryListResponse,
  CanvasLibrarySaveResponse,
  CanvasCreatedEvent,
  CanvasUpdatedEvent,
  CanvasDeletedEvent,
  CanvasTooLargeEvent
}

export const canvasRpc = defineDomain({
  name: 'canvas',
  methods: {
    create: defineMethod<(input?: CanvasCreateInput) => Promise<Canvas>>({
      channel: CanvasChannels.invoke.CREATE,
      params: ['input'],
      invokeArgs: ['input ?? {}']
    }),
    get: defineMethod<(id: string) => Promise<Canvas | null>>({
      channel: CanvasChannels.invoke.GET,
      params: ['id']
    }),
    update: defineMethod<(input: CanvasUpdateInput) => Promise<CanvasUpdateResponse>>({
      channel: CanvasChannels.invoke.UPDATE,
      params: ['input']
    }),
    delete: defineMethod<(id: string) => Promise<CanvasDeleteResponse>>({
      channel: CanvasChannels.invoke.DELETE,
      params: ['id']
    }),
    list: defineMethod<() => Promise<CanvasListResponse>>({
      channel: CanvasChannels.invoke.LIST,
      params: []
    }),
    uploadAsset: defineMethod<
      (input: {
        canvasId: string
        fileId: string
        mimeType: string
        data: ArrayBuffer
      }) => Promise<CanvasUploadAssetResponse>
    >({
      channel: CanvasChannels.invoke.UPLOAD_ASSET,
      params: ['input'],
      implementation: `async (input) =>
        invoke(${JSON.stringify(CanvasChannels.invoke.UPLOAD_ASSET)}, {
          canvasId: input.canvasId,
          fileId: input.fileId,
          mimeType: input.mimeType,
          data: Array.from(new Uint8Array(input.data))
        })`
    }),
    getAsset: defineMethod<(canvasId: string, fileId: string) => Promise<CanvasGetAssetResponse>>({
      channel: CanvasChannels.invoke.GET_ASSET,
      params: ['canvasId', 'fileId'],
      invokeArgs: ['{ canvasId, fileId }']
    }),
    listAssets: defineMethod<(canvasId: string) => Promise<CanvasListAssetsResponse>>({
      channel: CanvasChannels.invoke.LIST_ASSETS,
      params: ['canvasId'],
      invokeArgs: ['{ canvasId }']
    }),
    libraryList: defineMethod<() => Promise<CanvasLibraryListResponse>>({
      channel: CanvasChannels.invoke.LIBRARY_LIST,
      params: []
    }),
    librarySave: defineMethod<
      (libraryItems: CanvasLibraryItem[]) => Promise<CanvasLibrarySaveResponse>
    >({
      channel: CanvasChannels.invoke.LIBRARY_SAVE,
      params: ['libraryItems'],
      invokeArgs: ['{ libraryItems }']
    }),
    // Live-canvas ownership: the editor reports the canvas it has mounted so an
    // agent write can be routed to that instance instead of a headless
    // read-modify-write the next autosave would overwrite (#916).
    liveOpened: defineMethod<(canvasId: string) => Promise<{ ok: boolean }>>({
      channel: CanvasChannels.invoke.LIVE_OPENED,
      params: ['canvasId']
    }),
    liveClosed: defineMethod<(canvasId: string) => Promise<{ ok: boolean }>>({
      channel: CanvasChannels.invoke.LIVE_CLOSED,
      params: ['canvasId']
    })
  },
  events: {
    onCanvasCreated: defineEvent<CanvasCreatedEvent>(CanvasChannels.events.CREATED),
    onCanvasUpdated: defineEvent<CanvasUpdatedEvent>(CanvasChannels.events.UPDATED),
    onCanvasDeleted: defineEvent<CanvasDeletedEvent>(CanvasChannels.events.DELETED),
    onCanvasTooLarge: defineEvent<CanvasTooLargeEvent>(CanvasChannels.events.TOO_LARGE)
  }
})

export type CanvasClientAPI = RpcClient<typeof canvasRpc>
export type CanvasSubscriptions = RpcSubscriptions<typeof canvasRpc>
