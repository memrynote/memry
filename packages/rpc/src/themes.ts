import type {
  CreateThemeInput,
  CustomTheme,
  DeleteThemePayload,
  UpdateThemePayload
} from '../../contracts/src/themes-api.ts'
import { ThemesChannels } from '../../contracts/src/ipc-channels.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export interface ThemeMutationResult {
  success: boolean
  theme?: CustomTheme
  error?: string
}

export interface ThemeDeleteResult {
  success: boolean
  error?: string
}

export interface ThemeChangedEvent {
  id: string
}

export const themesRpc = defineDomain({
  name: 'themes',
  methods: {
    list: defineMethod<() => Promise<CustomTheme[]>>({
      channel: ThemesChannels.invoke.LIST,
      params: []
    }),
    create: defineMethod<(input: CreateThemeInput) => Promise<ThemeMutationResult>>({
      channel: ThemesChannels.invoke.CREATE,
      params: ['input']
    }),
    update: defineMethod<(input: UpdateThemePayload) => Promise<ThemeMutationResult>>({
      channel: ThemesChannels.invoke.UPDATE,
      params: ['input']
    }),
    delete: defineMethod<(input: DeleteThemePayload) => Promise<ThemeDeleteResult>>({
      channel: ThemesChannels.invoke.DELETE,
      params: ['input']
    })
  },
  events: {
    onThemeCreated: defineEvent<ThemeChangedEvent>(ThemesChannels.events.CREATED),
    onThemeUpdated: defineEvent<ThemeChangedEvent>(ThemesChannels.events.UPDATED),
    onThemeDeleted: defineEvent<ThemeChangedEvent>(ThemesChannels.events.DELETED)
  }
})

export type ThemesClientAPI = RpcClient<typeof themesRpc>
export type ThemesSubscriptions = RpcSubscriptions<typeof themesRpc>
