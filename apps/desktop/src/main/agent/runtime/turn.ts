import { randomUUID } from 'node:crypto'

import type { AgentBackendOptions, AgentTurnPermissions } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import type { BackendEvent } from '../cli/types'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import type { MessageAttachment } from '../storage/types'
import type { AgentBackend, BackendRunHandle } from '../backends/types'
import type { AgentBackendRegistry } from '../backends/registry'
import { broadcastAgentEvent } from './event-bus'
import { maybeCompact } from './compactor'
import { assemblePrompt, type PromptContext } from './prompt-assembler'
import { COMPACTION_THRESHOLD, estimateTokens } from './token-estimator'
import { extractAgentSourceRefs } from '../source-refs'
import type { AgentSourceRef } from '@memry/contracts/ipc-agent'

const logger = createLogger('AgentRuntime:Turn')

export interface TurnDeps {
  conversations: ConversationStore
  messages: MessageStore
  backends: AgentBackendRegistry
  trackRunHandle?: (conversationId: string, handle: BackendRunHandle) => BackendRunHandle
}

const DEFAULT_CONVERSATION_TITLE = 'New conversation'
const DEFAULT_TURN_PERMISSIONS: AgentTurnPermissions = {
  accessMode: 'vault_only',
  webSearchEnabled: false
}

export interface RunTurnInput {
  conversationId: string
  sourceWindowId: string
  text: string
  backendOptions: AgentBackendOptions
  permissions?: AgentTurnPermissions
  attachments: MessageAttachment[]
}

export async function runTurn(deps: TurnDeps, input: RunTurnInput): Promise<{ turnId: string }> {
  const turnId = randomUUID()
  const existingMessages = deps.messages.listByConversation(input.conversationId)
  const existingConversation = deps.conversations.getById(input.conversationId)
  const backend = deps.backends.get(input.backendOptions.backend)
  const permissions = input.permissions ?? DEFAULT_TURN_PERMISSIONS
  const shouldGenerateTitle =
    existingConversation?.title.trim() === DEFAULT_CONVERSATION_TITLE &&
    !existingMessages.some((message) => message.role === 'user')

  const user = deps.messages.append({
    conversationId: input.conversationId,
    role: 'user',
    content: { role: 'user', data: { text: input.text } },
    attachments: input.attachments,
    status: 'completed'
  })
  broadcastAgentEvent({
    kind: 'message_upserted',
    message: user
  })

  const titlePromise = shouldGenerateTitle
    ? maybeGenerateConversationTitle(deps, {
        conversationId: input.conversationId,
        windowId: input.sourceWindowId,
        text: input.text,
        attachments: input.attachments,
        backend,
        options: input.backendOptions
      })
    : Promise.resolve()

  let history = deps.messages
    .listByConversation(input.conversationId)
    .filter((message) => message.id !== user.id)
  const promptContext = buildPromptContext()
  const prompt = assemblePrompt({
    history,
    userMessage: input.text,
    attachments: input.attachments,
    permissions,
    context: promptContext
  })

  await maybeCompact({
    conversationId: input.conversationId,
    messages: deps.messages,
    summarize: (toSummarize) =>
      summarizeWithBackend(deps, {
        prompt: toSummarize,
        conversationId: input.conversationId,
        windowId: input.sourceWindowId,
        backend,
        options: input.backendOptions
      }),
    estimateLimit: COMPACTION_THRESHOLD,
    currentEstimate: estimateTokens(prompt)
  })

  history = deps.messages
    .listByConversation(input.conversationId)
    .filter((message) => message.id !== user.id)
  const compactedPrompt = assemblePrompt({
    history,
    userMessage: input.text,
    attachments: input.attachments,
    permissions,
    context: promptContext
  })

  const rawSub = await backend.runTurn({
    prompt: compactedPrompt,
    conversationId: input.conversationId,
    windowId: input.sourceWindowId,
    options: input.backendOptions,
    permissions,
    purpose: 'turn'
  })
  const sub = deps.trackRunHandle?.(input.conversationId, rawSub) ?? rawSub
  const stderrTextPromise = sub.stderr ? collectStreamText(sub.stderr) : Promise.resolve('')

  const assistant = deps.messages.append({
    conversationId: input.conversationId,
    role: 'assistant',
    content: { role: 'assistant', data: { text: '' } },
    attachments: [],
    status: 'streaming'
  })
  broadcastAgentEvent({
    kind: 'message_upserted',
    message: assistant
  })

  let buffered = ''
  let backendError: string | null = null
  const toolCalls = new Map<string, { name: string; args: unknown }>()
  const sourceRefs = new Map<string, AgentSourceRef>()
  try {
    for await (const event of sub.events) {
      if (event.kind === 'error') {
        backendError ??= event.message
        continue
      }
      await handleBackendEvent(event, {
        conversationId: input.conversationId,
        assistantMessageId: assistant.id,
        onToolUse: (toolUseId, name, args) => {
          toolCalls.set(toolUseId, { name, args })
        },
        onToolResult: (toolUseId, data) => {
          const toolCall = toolCalls.get(toolUseId)
          if (!toolCall) return
          for (const ref of extractAgentSourceRefs(toolCall.name, toolCall.args, data)) {
            sourceRefs.set(ref.href, ref)
          }
        },
        onAssistantText: (text) => {
          buffered += text
        }
      })
    }
    const exitCode = await sub.waitExit()
    const stderrText = (await stderrTextPromise).trim()

    if (backendError || exitCode !== 0) {
      const message = backendError ?? (stderrText || `${backend.id} exited with code ${exitCode}`)
      logger.warn('Agent backend exited non-zero', {
        backend: backend.id,
        exitCode,
        stderr: stderrText,
        backendError
      })
      const errored = deps.messages.markTerminal(assistant.id, 'error', {
        content: { role: 'assistant', data: { text: message } }
      })
      broadcastAgentEvent({
        kind: 'message_upserted',
        message: errored
      })
      broadcastAgentEvent({
        kind: 'turn_error',
        conversationId: input.conversationId,
        turnId,
        message
      })
      return { turnId }
    }

    const completed = deps.messages.markTerminal(assistant.id, 'completed', {
      content: {
        role: 'assistant',
        data: {
          text: buffered,
          ...(sourceRefs.size > 0 && { sources: [...sourceRefs.values()] })
        }
      }
    })
    broadcastAgentEvent({
      kind: 'message_upserted',
      message: completed
    })

    broadcastAgentEvent({
      kind: 'turn_completed',
      conversationId: input.conversationId,
      turnId
    })
  } finally {
    await sub.cleanup()
    await titlePromise
  }

  return { turnId }
}

async function maybeGenerateConversationTitle(
  deps: TurnDeps,
  input: {
    conversationId: string
    windowId: string
    text: string
    attachments: MessageAttachment[]
    backend: AgentBackend
    options: AgentBackendOptions
  }
): Promise<void> {
  try {
    const title =
      (await generateTitleWithBackend(deps, {
        prompt: assembleTitlePrompt(input.text, input.attachments),
        conversationId: input.conversationId,
        windowId: input.windowId,
        backend: input.backend,
        options: input.options
      })) ?? deterministicTitle(input.text)
    if (!title) return

    const updated = deps.conversations.update(input.conversationId, { title }, ['title'])
    broadcastAgentEvent({
      kind: 'conversation_updated',
      conversation: updated
    })
  } catch (error) {
    logger.warn('Conversation title generation failed', error)
    const title = deterministicTitle(input.text)
    if (!title) return
    const updated = deps.conversations.update(input.conversationId, { title }, ['title'])
    broadcastAgentEvent({
      kind: 'conversation_updated',
      conversation: updated
    })
  }
}

async function generateTitleWithBackend(
  deps: TurnDeps,
  input: {
    prompt: string
    conversationId: string
    windowId: string
    backend: AgentBackend
    options: AgentBackendOptions
  }
): Promise<string | null> {
  const rawSub = await input.backend.generateTitle({
    prompt: input.prompt,
    conversationId: input.conversationId,
    windowId: input.windowId,
    options: input.options,
    purpose: 'title'
  })
  const sub = deps.trackRunHandle?.(input.conversationId, rawSub) ?? rawSub
  let raw = ''
  let title = ''

  try {
    for await (const event of sub.events) {
      if (event.kind === 'assistant_delta') {
        raw += event.text
        title += event.text
      }
    }

    const exitCode = await sub.waitExit()
    if (exitCode !== 0) {
      const stderrText = sub.stderr ? (await collectStreamText(sub.stderr)).trim() : ''
      logger.warn('Conversation title backend exited non-zero', {
        backend: input.backend.id,
        exitCode,
        stderr: stderrText
      })
      return null
    }

    return sanitizeGeneratedTitle(title || raw)
  } finally {
    await sub.cleanup()
  }
}

function buildPromptContext(): PromptContext {
  return {
    now: new Date(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }
}

function assembleTitlePrompt(text: string, attachments: MessageAttachment[]): string {
  const lines = [
    'Generate a short title for this Memry Agent Chat conversation.',
    'Rules:',
    '- Use 2 to 6 words.',
    '- Preserve the user language.',
    '- Do not use quotes or trailing punctuation.',
    '- Return only the title.',
    '',
    `User message: ${text}`
  ]

  if (attachments.length > 0) {
    lines.push('', 'Attached references:')
    for (const attachment of attachments) {
      lines.push(`- ${attachment.kind}: ${attachment.label}`)
    }
  }

  return lines.join('\n')
}

function sanitizeGeneratedTitle(value: string): string | null {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return null

  const title = firstLine
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?:;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title || title === DEFAULT_CONVERSATION_TITLE) return null
  return title.length > 80 ? title.slice(0, 80).trim() : title
}

function deterministicTitle(text: string): string | null {
  return sanitizeGeneratedTitle(text.split(/\s+/).slice(0, 6).join(' '))
}

async function summarizeWithBackend(
  deps: TurnDeps,
  input: {
    prompt: string
    conversationId: string
    windowId: string
    backend: AgentBackend
    options: AgentBackendOptions
  }
): Promise<string> {
  const rawSub = await input.backend.summarize({
    prompt: input.prompt,
    conversationId: input.conversationId,
    windowId: input.windowId,
    options: input.options,
    purpose: 'summary'
  })
  const sub = deps.trackRunHandle?.(input.conversationId, rawSub) ?? rawSub
  let summary = ''

  try {
    for await (const event of sub.events) {
      if (event.kind === 'assistant_delta') summary += event.text
    }
    await sub.waitExit()
    return summary.trim()
  } finally {
    await sub.cleanup()
  }
}

async function collectStreamText(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  return text
}

async function handleBackendEvent(
  event: BackendEvent,
  ctx: {
    conversationId: string
    assistantMessageId: string
    onToolUse: (toolUseId: string, name: string, args: unknown) => void
    onToolResult: (toolUseId: string, data: unknown) => void
    onAssistantText: (text: string) => void
  }
): Promise<void> {
  if (event.kind === 'assistant_delta') {
    ctx.onAssistantText(event.text)
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: ctx.conversationId,
      messageId: ctx.assistantMessageId,
      text: event.text
    })
    return
  }

  if (event.kind === 'tool_use') {
    ctx.onToolUse(event.toolUseId, event.name, event.args)
    broadcastAgentEvent({
      kind: 'tool_call_started',
      conversationId: ctx.conversationId,
      toolCallId: event.toolUseId,
      name: event.name,
      args: event.args
    })
    return
  }

  if (event.kind === 'tool_result') {
    if (event.ok) {
      ctx.onToolResult(event.toolUseId, event.data)
      broadcastAgentEvent({
        kind: 'tool_call_completed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        result: event.data
      })
    } else {
      broadcastAgentEvent({
        kind: 'tool_call_failed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        error: event.error ?? { code: 'INTERNAL', message: 'unknown' }
      })
    }
    return
  }

  if (event.kind === 'unknown') {
    logger.debug('Unknown backend event', event.raw)
  }
}
