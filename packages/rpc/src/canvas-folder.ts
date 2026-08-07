import { z } from 'zod'
import { CanvasFolderChannels } from '../../contracts/src/ipc-channels.ts'
import {
  CanvasFolderCreateSchema,
  CanvasFolderDeleteSchema,
  CanvasFolderMoveSchema,
  CanvasFolderRenameSchema,
  CanvasFolderSetIconSchema,
  type CanvasFolder,
  type CanvasFolderListResponse,
  type CanvasFolderMutationResponse,
  type CanvasFolderDeleteResponse,
  type CanvasFolderCreatedEvent,
  type CanvasFolderUpdatedEvent,
  type CanvasFolderDeletedEvent
} from '../../contracts/src/canvas-folder-api.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export type CanvasFolderCreateInput = z.input<typeof CanvasFolderCreateSchema>
export type CanvasFolderRenameInput = z.input<typeof CanvasFolderRenameSchema>
export type CanvasFolderMoveInput = z.input<typeof CanvasFolderMoveSchema>
export type CanvasFolderSetIconInput = z.input<typeof CanvasFolderSetIconSchema>
export type CanvasFolderDeleteInput = z.input<typeof CanvasFolderDeleteSchema>

export type {
  CanvasFolder,
  CanvasFolderListResponse,
  CanvasFolderMutationResponse,
  CanvasFolderDeleteResponse,
  CanvasFolderCreatedEvent,
  CanvasFolderUpdatedEvent,
  CanvasFolderDeletedEvent
}

export const canvasFolderRpc = defineDomain({
  name: 'canvasFolder',
  methods: {
    list: defineMethod<() => Promise<CanvasFolderListResponse>>({
      channel: CanvasFolderChannels.invoke.LIST,
      params: []
    }),
    create: defineMethod<(input: CanvasFolderCreateInput) => Promise<CanvasFolderMutationResponse>>(
      {
        channel: CanvasFolderChannels.invoke.CREATE,
        params: ['input']
      }
    ),
    // `folder` comes back null when no live folder holds that path — the caller
    // is looking at a tree another device (or Finder) already changed.
    rename: defineMethod<(input: CanvasFolderRenameInput) => Promise<CanvasFolderMutationResponse>>(
      {
        channel: CanvasFolderChannels.invoke.RENAME,
        params: ['input']
      }
    ),
    move: defineMethod<(input: CanvasFolderMoveInput) => Promise<CanvasFolderMutationResponse>>({
      channel: CanvasFolderChannels.invoke.MOVE,
      params: ['input']
    }),
    setIcon: defineMethod<
      (input: CanvasFolderSetIconInput) => Promise<CanvasFolderMutationResponse>
    >({
      channel: CanvasFolderChannels.invoke.SET_ICON,
      params: ['input']
    }),
    delete: defineMethod<(input: CanvasFolderDeleteInput) => Promise<CanvasFolderDeleteResponse>>({
      channel: CanvasFolderChannels.invoke.DELETE,
      params: ['input']
    })
  },
  events: {
    onCanvasFolderCreated: defineEvent<CanvasFolderCreatedEvent>(
      CanvasFolderChannels.events.CREATED
    ),
    onCanvasFolderUpdated: defineEvent<CanvasFolderUpdatedEvent>(
      CanvasFolderChannels.events.UPDATED
    ),
    onCanvasFolderDeleted: defineEvent<CanvasFolderDeletedEvent>(
      CanvasFolderChannels.events.DELETED
    )
  }
})

export type CanvasFolderClientAPI = RpcClient<typeof canvasFolderRpc>
export type CanvasFolderSubscriptions = RpcSubscriptions<typeof canvasFolderRpc>
