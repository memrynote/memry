import type { IosBetaJoinInput, IosBetaJoinResult } from '../../contracts/src/ios-beta-api.ts'
import { IosBetaChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export const iosBetaRpc = defineDomain({
  name: 'iosBeta',
  methods: {
    join: defineMethod<(input: IosBetaJoinInput) => Promise<IosBetaJoinResult>>({
      channel: IosBetaChannels.invoke.JOIN,
      params: ['input']
    })
  },
  events: {}
})

export type IosBetaClientAPI = RpcClient<typeof iosBetaRpc>
