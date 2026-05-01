import type { TelemetryEvent } from '../../contracts/src/telemetry-api.ts'
import { TelemetryChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export interface TelemetrySettings {
  enabled: boolean
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>

export const telemetryRpc = defineDomain({
  name: 'telemetry',
  methods: {
    track: defineMethod<(event: TelemetryEvent) => SuccessResponse>({
      channel: TelemetryChannels.invoke.TRACK,
      params: ['event']
    }),
    flush: defineMethod<() => SuccessResponse>({
      channel: TelemetryChannels.invoke.FLUSH
    }),
    getSettings: defineMethod<() => Promise<TelemetrySettings>>({
      channel: TelemetryChannels.invoke.GET_SETTINGS
    }),
    setEnabled: defineMethod<(enabled: boolean) => SuccessResponse>({
      channel: TelemetryChannels.invoke.SET_ENABLED,
      params: ['enabled']
    })
  },
  events: {}
})

export type TelemetryClientAPI = RpcClient<typeof telemetryRpc>
