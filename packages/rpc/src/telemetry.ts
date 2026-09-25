import type { TelemetryEvent } from '../../contracts/src/telemetry-api.ts'
import { TelemetryChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export interface TelemetrySettings {
  enabled: boolean
  /**
   * Send a diagnostic report automatically when an error screen is shown.
   * Optional so a response from an older main process still type-checks;
   * absent means on (the default).
   */
  autoSendDiagnostics?: boolean
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>
type FlushResponse = Promise<{
  success: boolean
  attempted: number
  accepted: number
  error?: string
}>

export const telemetryRpc = defineDomain({
  name: 'telemetry',
  methods: {
    track: defineMethod<(event: TelemetryEvent) => SuccessResponse>({
      channel: TelemetryChannels.invoke.TRACK,
      params: ['event']
    }),
    flush: defineMethod<() => FlushResponse>({
      channel: TelemetryChannels.invoke.FLUSH
    }),
    getSettings: defineMethod<() => Promise<TelemetrySettings>>({
      channel: TelemetryChannels.invoke.GET_SETTINGS
    }),
    setEnabled: defineMethod<(enabled: boolean) => SuccessResponse>({
      channel: TelemetryChannels.invoke.SET_ENABLED,
      params: ['enabled']
    }),
    setAutoSendDiagnostics: defineMethod<(enabled: boolean) => SuccessResponse>({
      channel: TelemetryChannels.invoke.SET_AUTO_SEND_DIAGNOSTICS,
      params: ['enabled']
    })
  },
  events: {}
})

export type TelemetryClientAPI = RpcClient<typeof telemetryRpc>
