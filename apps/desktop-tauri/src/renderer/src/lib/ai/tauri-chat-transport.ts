import {
  aiDocumentFormats,
  injectDocumentStateMessages,
  toolDefinitionsToToolSet
} from '@blocknote/xl-ai'
import {
  convertToModelMessages,
  streamText,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk
} from 'ai'
import { commands, type AiProvider, type InlineAiSettings } from '../../../../generated/bindings'
import { createLanguageModel } from './language-model'

type ToolDefinitions = Parameters<typeof toolDefinitionsToToolSet>[0]

/**
 * Anthropic maps 'required' to tool_choice {type: "any"}, which newer Claude models reject with
 * a 400. Under 'auto' the model is steered to the tools by the BlockNote system prompt instead
 * of being forced (`ai-chat-server.ts:81`).
 */
export function toolChoiceFor(provider: AiProvider): 'auto' | 'required' {
  return provider === 'anthropic' ? 'auto' : 'required'
}

/**
 * The BlockNote AI extension's transport: the `streamText` call of Electron's inline chat
 * server (`ai-chat-server.ts:211`) run in the webview, its provider requests sent through Rust.
 * Settings are read on every send, so a change applies to the next request.
 */
export class TauriChatTransport implements ChatTransport<UIMessage> {
  constructor(
    private readonly loadSettings: () => Promise<InlineAiSettings> = () =>
      commands.aiInlineGetSettings()
  ) {}

  async sendMessages({
    messages,
    body,
    abortSignal
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const settings = await this.loadSettings()
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote sends `{ toolDefinitions }` as the body (`sendMessageWithAIRequest.ts`)
    const { toolDefinitions } = (body ?? {}) as { toolDefinitions: ToolDefinitions }
    const result = streamText({
      model: createLanguageModel(settings),
      system: aiDocumentFormats.html.systemPrompt,
      messages: await convertToModelMessages(injectDocumentStateMessages(messages)),
      tools: toolDefinitionsToToolSet(toolDefinitions),
      toolChoice: toolChoiceFor(settings.provider),
      abortSignal
    })
    // The provider's or Rust's message (a missing key, an unreachable provider) reaches the AI
    // menu; neither ever carries the key.
    return result.toUIMessageStream({
      onError: (error) => (error instanceof Error ? error.message : String(error))
    })
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null)
  }
}
