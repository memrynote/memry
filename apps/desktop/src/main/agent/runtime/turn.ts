import { randomUUID } from 'node:crypto'

import type { AgentBackendOptions, AgentTurnPermissions } from '@memry/contracts/ipc-agent'

import { toSafeToken } from '@memry/contracts/telemetry-api'

import { createLogger } from '../../lib/logger'
import { trackMainError, trackMainLog } from '../../telemetry/diagnostics'
import { trackMainEvent } from '../../telemetry/track'
import type { BackendEvent } from '../cli/types'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import type { Message, MessageAttachment } from '../storage/types'
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

// How long an abandoned child gets to die before the turn stops waiting on it.
// Comfortably inside the 5s force-exit budget main gives the whole shutdown.
const ABANDONED_KILL_GRACE_MS = 2000
const DEFAULT_CONVERSATION_TITLE = 'New conversation'
// Title and summary stderr is drained purely to keep the child moving, so it is
// retained as a bounded tail rather than in full: a CLI can emit megabytes of
// node warnings and MCP diagnostics, and the reason it failed is at the end.
const STDERR_TAIL_LIMIT = 8 * 1024
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
  // Listing the transcript is the expensive part of a turn: every row costs two
  // AEAD opens, two JSON.parses and a zod parse. It is listed once here and
  // threaded through the rest of the turn, so the cost stays O(history) per
  // message instead of a multiple of it. Nothing appends to this conversation
  // between here and the last use below except this turn itself, and those
  // appends return the message, so the in-memory copy stays authoritative.
  const history = deps.messages.listByConversation(input.conversationId)
  const existingConversation = deps.conversations.getById(input.conversationId)
  const backend = deps.backends.get(input.backendOptions.backend)
  const permissions = input.permissions ?? DEFAULT_TURN_PERMISSIONS
  // agent_chat_started keys on this heuristic; revisit if a user-facing rename path is added
  const shouldGenerateTitle =
    existingConversation?.title.trim() === DEFAULT_CONVERSATION_TITLE &&
    !history.some((message) => message.role === 'user')

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

  const backendLabel = input.backendOptions.backend
  if (shouldGenerateTitle) {
    trackMainEvent('agent_chat_started', { surface: 'ai', action: 'started', source: backendLabel })
  }
  trackMainEvent('agent_chat_message_sent', { surface: 'ai', action: 'sent', source: backendLabel })
  const turnStartedAt = Date.now()
  const trackTurnCompleted = (result: 'success' | 'failed'): void => {
    trackMainEvent('ai_action_completed', {
      surface: 'ai',
      action: 'turn_completed',
      source: backendLabel,
      result,
      metrics: { durationMs: Date.now() - turnStartedAt }
    })
  }

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

  const promptContext = buildPromptContext()
  const prompt = assemblePrompt({
    history,
    userMessage: input.text,
    attachments: input.attachments,
    permissions,
    context: promptContext
  })

  let compactedPrompt = prompt
  try {
    const compaction = await maybeCompact({
      conversationId: input.conversationId,
      messages: deps.messages,
      // assemblePrompt renders the turn's own user message separately, but
      // compaction weighs the whole transcript, so it gets history plus `user`.
      history: [...history, user],
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
    // Compaction only ever appends a marker, so the post-compaction history is
    // exactly the pre-compaction one plus that marker — no re-list needed. When
    // it did nothing, re-assembling would have rebuilt a byte-identical prompt.
    if (compaction) {
      compactedPrompt = assemblePrompt({
        history: [...history, compaction],
        userMessage: input.text,
        attachments: input.attachments,
        permissions,
        context: promptContext
      })
    }
  } catch (error) {
    // A failed or empty summarization must not become a 'compacted' marker —
    // compactedHistory replaces all prior history with the summary, so a bad
    // one would permanently destroy conversation context. Skip compaction for
    // this turn and run with the uncompacted prompt instead.
    logger.warn('Conversation compaction failed; skipping compaction for this turn', error)
    trackMainError('agent', 'compact_summarize', error)
  }

  const rawSub = await backend.runTurn({
    prompt: compactedPrompt,
    conversationId: input.conversationId,
    windowId: input.sourceWindowId,
    options: input.backendOptions,
    permissions,
    purpose: 'turn'
  })
  const sub = deps.trackRunHandle?.(input.conversationId, rawSub) ?? rawSub

  // The child is spawned and tracked, but the turn's own try/finally below has
  // not been entered yet. An encrypted SQLite append or a broadcast to a window
  // that died mid-send can throw here, and nothing upstream stops subprocesses —
  // the IPC caller's catch only logs and reports. Without this guard the child
  // runs for the rest of the session and its pid never leaves the tracking map.
  let stderrTextPromise: Promise<string>
  let assistant: Message
  try {
    stderrTextPromise = sub.stderr ? collectStreamText(sub.stderr) : Promise.resolve('')

    assistant = deps.messages.append({
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
  } catch (error) {
    await discardStrandedSubprocess(sub)
    throw error
  }

  let buffered = ''
  let backendError: string | null = null
  let exitObserved = false
  let unknownEventCount = 0
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
        onToolFailed: (toolUseId, errorCode) => {
          // The only tool-failure signal for CLI backends — transport failures
          // never reach the MCP server's own catch. Tool name only, never args.
          const toolName = toolCalls.get(toolUseId)?.name
          trackMainEvent('ai_action_completed', {
            surface: 'ai',
            action: 'tool_call',
            source: backendLabel,
            result: 'failed',
            errorCode: toSafeToken(errorCode ?? 'INTERNAL', 'INTERNAL'),
            ...(toolName ? { dimensions: { tool: toSafeToken(toolName, 'unknown_tool') } } : {})
          })
        },
        onAssistantText: (text) => {
          buffered += text
        },
        onUnknownEvent: () => {
          unknownEventCount += 1
        }
      })
    }
    const exitCode = await sub.waitExit()
    exitObserved = true
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
      trackTurnCompleted('failed')
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
    if (!buffered.trim() && unknownEventCount > 0) {
      // A "successful" turn whose events all failed to parse blanks the reply
      // while dashboards show success — the realistic CLI output-format-drift
      // scenario. The per-event logger.debug never ships, so flag it here.
      trackMainLog('warn', {
        scope: 'AgentRuntime:Turn',
        action: 'empty_turn_unknown_events',
        metrics: { itemCount: unknownEventCount }
      })
    }
    trackTurnCompleted('success')
  } finally {
    // Only ever reached once the turn is over: either waitExit() already
    // resolved (exitObserved) or the event loop above threw and abandoned a
    // child that is still running. A slow turn is still inside the loop, so it
    // is never touched here.
    if (!exitObserved) await killAbandonedChild(sub)
    await sub.cleanup()
    await titlePromise
  }

  return { turnId }
}

// cleanup() is where the tracked-handle wrapper untracks the pid, which removes
// it from the map killAll() walks at quit. A child still alive at that moment is
// unreachable forever, so it has to be killed first — and the caller must wait
// for it to actually be gone, not merely signalled. Resolves true only when the
// exit was observed.
async function killAbandonedChild(sub: BackendRunHandle): Promise<boolean> {
  try {
    sub.kill()
  } catch (error) {
    logger.warn('Failed to kill abandoned agent subprocess', { pid: sub.pid, error })
    return false
  }

  // Bounded: killAll() awaits in-flight turns and main force-exits 5s into
  // shutdown, so an unbounded wait here would trade the leak for a hang.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ABANDONED_KILL_GRACE_MS)
  })
  try {
    const exited = await Promise.race([sub.waitExit().then(() => true), timedOut])
    if (!exited) {
      logger.warn('Abandoned agent subprocess did not exit after kill', { pid: sub.pid })
    }
    return exited
  } catch (error) {
    logger.warn('Failed to await abandoned agent subprocess exit', { pid: sub.pid, error })
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stop a child that was tracked but never handed to the turn's event loop.
 *
 * cleanup() is where the tracked-handle wrapper untracks the pid, and that map
 * is what killAll() walks at quit — so the child is only untracked once the OS
 * says it is gone. A survivor stays tracked on purpose: still leaking, but still
 * reachable at shutdown, which an untracked survivor never is again.
 */
async function discardStrandedSubprocess(sub: BackendRunHandle): Promise<void> {
  if (!(await killAbandonedChild(sub))) {
    logger.warn('Stranded agent subprocess still running; leaving it tracked for shutdown', {
      pid: sub.pid
    })
    return
  }
  await sub.cleanup()
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
  // Draining has to start before the event loop below, not after waitExit():
  // once the OS stderr pipe buffer fills, the child blocks on write, so it
  // stops producing stdout and never exits, and both the loop and waitExit()
  // wait forever on a child that is waiting on us.
  const stderrTailPromise = sub.stderr ? collectStreamTail(sub.stderr) : Promise.resolve('')
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
      const stderrText = (await stderrTailPromise).trim()
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
    'Generate a short title for this memrynote Agent Chat conversation.',
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
  // Same deadlock as the title path: a summarize child that fills the stderr
  // pipe blocks on write and never exits, and this one runs before the turn's
  // own subprocess, so it strands the whole turn.
  const stderrTailPromise = sub.stderr ? collectStreamTail(sub.stderr) : Promise.resolve('')
  let summary = ''

  try {
    for await (const event of sub.events) {
      if (event.kind === 'assistant_delta') summary += event.text
    }
    const exitCode = await sub.waitExit()
    if (exitCode !== 0) {
      // The thrown message is swallowed into a compaction warning upstream, so
      // stderr is logged here or the CLI's own reason is lost entirely.
      logger.warn('Conversation summary backend exited non-zero', {
        backend: input.backend.id,
        exitCode,
        stderr: (await stderrTailPromise).trim()
      })
      throw new Error(`${input.backend.id} summarize exited with code ${exitCode}`)
    }
    const trimmed = summary.trim()
    if (!trimmed) {
      throw new Error(`${input.backend.id} summarize produced an empty summary`)
    }
    return trimmed
  } finally {
    await sub.cleanup()
  }
}

// Consumes the stream to the end — that is the point, the child cannot finish
// until it does — while retaining only the last STDERR_TAIL_LIMIT characters.
// Never rejects: callers only await it on the failure branch, so a read error
// on a stream nobody is waiting for must not become an unhandled rejection in
// main (where index.ts's uncaughtException handler would silently swallow it).
async function collectStreamTail(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = ''
  try {
    for await (const chunk of stream) {
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (text.length > STDERR_TAIL_LIMIT) text = text.slice(-STDERR_TAIL_LIMIT)
    }
  } catch (error) {
    logger.warn('Failed to read backend stderr', error)
  }
  return text
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
    onToolFailed: (toolUseId: string, errorCode: string | undefined) => void
    onAssistantText: (text: string) => void
    onUnknownEvent: () => void
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
      ctx.onToolFailed(event.toolUseId, event.error?.code)
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
    ctx.onUnknownEvent()
    logger.debug('Unknown backend event', event.raw)
  }
}
