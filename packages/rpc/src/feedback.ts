import type { FeedbackSubmit, FeedbackSubmitResult } from '../../contracts/src/feedback-api.ts'
import { FeedbackChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export const feedbackRpc = defineDomain({
  name: 'feedback',
  methods: {
    submit: defineMethod<(input: FeedbackSubmit) => Promise<FeedbackSubmitResult>>({
      channel: FeedbackChannels.invoke.SUBMIT,
      params: ['input']
    })
  },
  events: {}
})

export type FeedbackClientAPI = RpcClient<typeof feedbackRpc>
