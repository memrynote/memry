import type {
  EditorContextMenuSpelling,
  WritingAssistInput,
  WritingAssistResponse
} from '../../contracts/src/writing-tools-api.ts'
import { WritingToolsChannels } from '../../contracts/src/ipc-channels.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export const writingToolsRpc = defineDomain({
  name: 'writingTools',
  methods: {
    generateAssist: defineMethod<(input: WritingAssistInput) => Promise<WritingAssistResponse>>({
      channel: WritingToolsChannels.invoke.GENERATE_ASSIST,
      params: ['input']
    }),
    claimEditorContextMenu: defineMethod<() => boolean>({
      channel: WritingToolsChannels.invoke.CLAIM_EDITOR_CONTEXT_MENU,
      mode: 'sync'
    }),
    addWordToDictionary: defineMethod<(word: string) => Promise<boolean>>({
      channel: WritingToolsChannels.invoke.ADD_WORD_TO_DICTIONARY,
      params: ['word']
    })
  },
  events: {
    onEditorContextMenu: defineEvent<EditorContextMenuSpelling>(
      WritingToolsChannels.events.EDITOR_CONTEXT_MENU
    )
  }
})

export type WritingToolsClientAPI = RpcClient<typeof writingToolsRpc>
export type WritingToolsSubscriptions = RpcSubscriptions<typeof writingToolsRpc>
