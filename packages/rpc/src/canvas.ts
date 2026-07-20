import { z } from 'zod'
import { CanvasChannels } from '../../contracts/src/ipc-channels.ts'
import {
  CanvasCreateSchema,
  CanvasUpdateSchema,
  type Canvas,
  type CanvasSummary,
  type CanvasEntityRef,
  type CanvasListResponse,
  type CanvasDeleteResponse,
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
  CanvasEntityRef,
  CanvasListResponse,
  CanvasDeleteResponse,
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
    update: defineMethod<(input: CanvasUpdateInput) => Promise<CanvasSummary>>({
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
