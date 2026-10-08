import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOllama } from 'ollama-ai-provider-v2'
import {
  type AgentBackendStatus,
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings,
  type AgentToolsOffReason
} from '@memry/contracts/ipc-agent'
import { stepCountIs, streamText, wrapLanguageModel } from 'ai'

import { createLogger } from '../../lib/logger'
import type { BackendEvent } from '../cli/types'
import { AgentToolBridge, createAiSdkToolSet } from './tool-bridge'
import {
  TextToolCallSplitter,
  toolCallProfileMiddleware,
  type ToolCallProfile
} from './tool-call-profile'
import { toolImageMiddleware } from './tool-images'
import type { TurnWriteGrant } from '../turn-grants'
import type {
  AgentBackend,
  AgentBackendRunInput,
  AgentBackendTurnInput,
  BackendRunHandle
} from './types'

const logger = createLogger('Agent:LocalProvider')

let nextLocalRunPid = -1

// ponytail: fixed 8192-token window fixes #591. Ollama's default context is 4096
// and OLLAMA_NUM_PARALLEL divides it across slots, so Memry's system prompt + tool
// schemas overflow and the reply is cut to one token. Promote to a user setting only
// if someone needs to tune it.
const OLLAMA_NUM_CTX = 8192

// ponytail: a capability probe costs /v1/models, a streaming completion and two full
// tool round-trip generations (#1009), so it cannot run per message. Results are cached
// per (preset, baseUrl, model, api key); anything the user can change from outside the
// app is bounded by these TTLs instead.
const PROBE_TTL_MS = 10 * 60_000
// A "no tools" verdict is usually a model property, but a transient provider error at
// the tool step looks identical, so it expires fast.
const PROBE_DEGRADED_TTL_MS = 60_000
// Long enough for a slow local thinking model to finish the tool probe's two generations.
const PROBE_REQUEST_TIMEOUT_MS = 120_000

// The assembled prompt names the vault tools, so a model that was sent no tool schemas
// writes its tool calls out as plain text unless it is told they are gone.
const TOOLS_UNAVAILABLE_SYSTEM =
  'No tools are available in this conversation. Do not write tool calls or tool syntax. ' +
  'Answer in plain text, and if the request needs vault access, say that vault tools are off for this model.'

const PROBE_TOOL_NAME = 'memry_probe_echo'
// One white pixel: enough for a text-only model or server to refuse image input.
const PROBE_IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const PROBE_USER_MESSAGE = { role: 'user', content: 'Call the echo tool with text "ok".' }

/**
 * What the probe decided about tools for one provider configuration. `detail` on `off`
 * is the provider's own error text and stays null when Memry only observed the model.
 */
type ToolAccess =
  | { kind: 'on'; profile: ToolCallProfile }
  | { kind: 'off'; reason: AgentToolsOffReason; detail: string | null }
  | { kind: 'unreachable' }

interface LocalProbe {
  result: AgentLocalProviderProbeResult
  tools: ToolAccess
}

type ToolProbe =
  | { ok: true; profile: ToolCallProfile }
  | {
      ok: false
      reason: Exclude<AgentToolsOffReason, 'streaming_unsupported'>
      called: boolean
      detail: string
      providerDetail: string | null
    }

// Ollama's native API (the only endpoint that accepts num_ctx) lives at /api, while
// the stored ollama preset baseUrl points at the /v1 OpenAI-compat path.
function toOllamaApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '') + '/api'
}

export class LocalOpenAICompatibleBackend implements AgentBackend {
  readonly id = 'local_openai_compatible' as const

  // Single slot: only one provider configuration is live at a time, so an entry for an
  // older one is worthless and this can never grow. `apiKey` is compared by value and
  // never hashed or otherwise derived — the cache only needs to know whether the key
  // changed since the last probe.
  private probeCache: {
    settingsKey: string
    apiKey: string | null
    probe: LocalProbe
    expiresAt: number
  } | null = null
  private probeInFlight: {
    settingsKey: string
    apiKey: string | null
    promise: Promise<LocalProbe>
  } | null = null
  // Whether the chat model takes image input, learned the first time a tool returns an
  // image (FB-002). Same single slot as the tool probe; the model is part of the key
  // because a chat can pick a model other than the configured one.
  private imageInputCache: {
    key: string
    apiKey: string | null
    accepts: boolean
    expiresAt: number
  } | null = null

  constructor(
    private readonly deps: {
      getSettings: () => Promise<AgentLocalProviderSettings>
      getApiKey: () => Promise<string | null>
      toolBridge: AgentToolBridge
      fetch?: typeof fetch
    }
  ) {}

  async runTurn(input: AgentBackendTurnInput): Promise<BackendRunHandle> {
    return this.run(input, true)
  }

  async generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, false)
  }

  async summarize(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, false)
  }

  async getStatus(): Promise<AgentBackendStatus> {
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey()
    const result = await testOpenAiCompatibleConnection(settings, this.deps.fetch ?? fetch, apiKey)
    return {
      backend: this.id,
      available: result.connected && result.modelAvailable,
      reason: result.connected ? null : 'connection_failed',
      detail: result.detail
    }
  }

  async probeCapabilities(): Promise<AgentLocalProviderProbeResult> {
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey()
    // The settings screen asks for this on demand, so it must be live and it doubles as
    // the manual way to clear a stale verdict.
    return (await this.resolveProbe(settings, apiKey, { force: true })).result
  }

  private async resolveProbe(
    settings: AgentLocalProviderSettings,
    apiKey: string | null,
    options: { force?: boolean } = {}
  ): Promise<LocalProbe> {
    const settingsKey = probeSettingsKey(settings)
    if (!options.force) {
      const cached = this.probeCache
      if (
        cached?.settingsKey === settingsKey &&
        cached.apiKey === apiKey &&
        cached.expiresAt > Date.now()
      ) {
        return cached.probe
      }
      // Two turns starting at once must share one probe rather than racing.
      const pending = this.probeInFlight
      if (pending?.settingsKey === settingsKey && pending.apiKey === apiKey) return pending.promise
    }

    const promise = this.runProbe(settingsKey, settings, apiKey)
    if (!options.force) this.probeInFlight = { settingsKey, apiKey, promise }
    try {
      return await promise
    } finally {
      if (this.probeInFlight?.promise === promise) this.probeInFlight = null
    }
  }

  private async runProbe(
    settingsKey: string,
    settings: AgentLocalProviderSettings,
    apiKey: string | null
  ): Promise<LocalProbe> {
    const probe = await probeLocalProvider(settings, this.deps.fetch ?? fetch, apiKey)
    const ttl = probeCacheTtlMs(probe.result)
    this.probeCache = ttl > 0 ? { settingsKey, apiKey, probe, expiresAt: Date.now() + ttl } : null
    return probe
  }

  private async acceptsImages(
    settings: AgentLocalProviderSettings,
    modelName: string,
    apiKey: string | null
  ): Promise<boolean> {
    const key = JSON.stringify([probeSettingsKey(settings), modelName])
    const cached = this.imageInputCache
    if (cached?.key === key && cached.apiKey === apiKey && cached.expiresAt > Date.now()) {
      return cached.accepts
    }
    const accepts = await probeImageInput(settings, modelName, this.deps.fetch ?? fetch, apiKey)
    const ttl = accepts ? PROBE_TTL_MS : PROBE_DEGRADED_TTL_MS
    this.imageInputCache = { key, apiKey, accepts, expiresAt: Date.now() + ttl }
    return accepts
  }

  private async run(
    input: AgentBackendRunInput & { writeGrant?: TurnWriteGrant },
    allowTools: boolean
  ): Promise<BackendRunHandle> {
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey()
    const options = input.options.backend === this.id ? input.options : null
    const modelName = options?.model || settings.model
    const isOllama = settings.preset === 'ollama'
    const model = isOllama
      ? createOllama({
          baseURL: toOllamaApiBaseUrl(settings.baseUrl),
          ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {})
        })(modelName)
      : // The OpenAI provider drops `reasoning_content`, and thinking-mode providers
        // such as DeepSeek reject a tool loop that does not send it back (#2609).
        createOpenAICompatible({
          name: 'local-openai-compatible',
          baseURL: settings.baseUrl,
          ...(apiKey ? { apiKey } : {})
        }).chatModel(modelName)
    const controller = new AbortController()
    const tools =
      allowTools && (options?.toolsEnabled ?? true) && input.writeGrant
        ? (await this.resolveProbe(settings, apiKey)).tools
        : null
    const toolsUnavailable: BackendEvent[] =
      tools?.kind === 'off'
        ? [{ kind: 'tools_unavailable', reason: tools.reason, detail: tools.detail }]
        : []
    const result = streamText({
      model:
        tools?.kind === 'on'
          ? wrapLanguageModel({
              model,
              middleware: [
                toolCallProfileMiddleware(tools.profile),
                toolImageMiddleware(() => this.acceptsImages(settings, modelName, apiKey))
              ]
            })
          : model,
      prompt: input.prompt,
      ...(toolsUnavailable.length > 0 ? { system: TOOLS_UNAVAILABLE_SYSTEM } : {}),
      abortSignal: controller.signal,
      stopWhen: stepCountIs(8),
      ...(isOllama
        ? { providerOptions: { ollama: { options: { num_ctx: OLLAMA_NUM_CTX } } } }
        : {}),
      ...(tools?.kind === 'on' && input.writeGrant
        ? {
            tools: createAiSdkToolSet(this.deps.toolBridge, {
              writeGrant: input.writeGrant,
              windowId: input.windowId
            })
          }
        : {})
    })
    let exitCode = 0
    let stderr = ''

    return {
      events: mapAiSdkEvents(toolsUnavailable, result.fullStream, (error) => {
        exitCode = 1
        stderr = errorMessage(error)
      }),
      stderr: textToStream(() => stderr),
      pid: nextLocalRunPid--,
      kill: () => controller.abort(),
      waitExit: async () => exitCode,
      cleanup: async () => {}
    }
  }
}

async function* mapAiSdkEvents(
  leading: BackendEvent[],
  stream: AsyncIterable<unknown>,
  onError: (error: unknown) => void
): AsyncIterable<BackendEvent> {
  yield* leading
  try {
    for await (const part of stream) {
      const event = partToBackendEvent(part)
      if (event) yield event
    }
  } catch (error) {
    onError(error)
  }
}

function partToBackendEvent(part: unknown): BackendEvent | null {
  if (!part || typeof part !== 'object' || !('type' in part)) return null
  const typed = part as Record<string, unknown>

  if (typed.type === 'text-delta' && typeof typed.text === 'string') {
    return { kind: 'assistant_delta', text: typed.text }
  }

  if (typed.type === 'reasoning-start') {
    return { kind: 'reasoning_delta', text: '', startsBlock: true }
  }

  if (typed.type === 'reasoning-delta' && typeof typed.text === 'string') {
    return { kind: 'reasoning_delta', text: typed.text, startsBlock: false }
  }

  if (typed.type === 'tool-call') {
    return {
      kind: 'tool_use',
      toolUseId: String(typed.toolCallId),
      name: String(typed.toolName),
      args: typed.input
    }
  }

  if (typed.type === 'tool-result') {
    const output = typed.output as { ok?: boolean; data?: unknown; error?: unknown } | undefined
    const error = toToolError(output?.error)
    return {
      kind: 'tool_result',
      toolUseId: String(typed.toolCallId),
      ok: output?.ok !== false,
      data: typed.output,
      ...(error ? { error } : {})
    }
  }

  if (typed.type === 'tool-error') {
    return {
      kind: 'tool_result',
      toolUseId: String(typed.toolCallId),
      ok: false,
      error: { code: 'TOOL_ERROR', message: errorMessage(typed.error) }
    }
  }

  // streamText reports a failed provider call as a stream part, not a throw.
  if (typed.type === 'error') return { kind: 'error', message: errorMessage(typed.error) }

  if (typed.type === 'finish') return { kind: 'message_stop' }
  return null
}

async function* textToStream(getText: () => string): AsyncIterable<Buffer> {
  const text = getText()
  if (text) yield Buffer.from(text)
}

export async function testOpenAiCompatibleConnection(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null = null
): Promise<AgentLocalProviderProbeResult> {
  try {
    const models = await listOpenAiCompatibleModels(settings.baseUrl, fetchImpl, apiKey)
    const modelAvailable = !settings.model || models.includes(settings.model)
    return {
      connected: true,
      modelAvailable,
      streamingSupported: true,
      toolCallingSupported: false,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: modelAvailable ? null : `Model ${settings.model} was not returned by /v1/models.`
    }
  } catch (error) {
    return {
      connected: false,
      modelAvailable: false,
      streamingSupported: false,
      toolCallingSupported: false,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: errorMessage(error)
    }
  }
}

async function probeLocalProvider(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null
): Promise<LocalProbe> {
  const connection = await testOpenAiCompatibleConnection(settings, fetchImpl, apiKey)
  if (!connection.connected || !connection.modelAvailable) {
    return { result: connection, tools: { kind: 'unreachable' } }
  }

  const streaming = await probeStreaming(settings, fetchImpl, apiKey)
  if (!streaming.streamingSupported) {
    logger.warn(`Streaming probe failed for model ${settings.model}: ${streaming.detail}`)
    return {
      result: { ...connection, ...streaming, toolsEnabled: false },
      tools: { kind: 'off', reason: 'streaming_unsupported', detail: null }
    }
  }

  const toolProbe = await probeToolCalling(settings, fetchImpl, apiKey)
  if (toolProbe.ok) {
    return {
      result: {
        ...connection,
        ...streaming,
        toolCallingSupported: true,
        toolContinuationSupported: true,
        toolsEnabled: true,
        detail: null
      },
      tools: { kind: 'on', profile: toolProbe.profile }
    }
  }
  logger.warn(`Tool probe failed for model ${settings.model}: ${toolProbe.detail}`)
  return {
    result: {
      ...connection,
      ...streaming,
      toolCallingSupported: toolProbe.called,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: toolProbe.detail
    },
    tools: { kind: 'off', reason: toolProbe.reason, detail: toolProbe.providerDetail }
  }
}

// Non-secret half of the probe identity. The API key is deliberately not part of this
// string: it is compared by value on the cache slot instead, so no derived form of the
// user's credential is ever produced.
function probeSettingsKey(settings: AgentLocalProviderSettings): string {
  return JSON.stringify([settings.preset, settings.baseUrl, settings.model])
}

function probeCacheTtlMs(result: AgentLocalProviderProbeResult): number {
  // Unreachable provider, model not pulled yet, or no streaming: the user fixes all of
  // these outside the app, and none of them paid for the expensive tool probe, so never
  // cache them — starting the local server must take effect on the very next turn.
  if (!result.connected || !result.modelAvailable || !result.streamingSupported) return 0
  return result.toolsEnabled ? PROBE_TTL_MS : PROBE_DEGRADED_TTL_MS
}

export async function listOpenAiCompatibleModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  apiKey: string | null = null
): Promise<string[]> {
  const response = await fetchImpl(new URL('models', ensureTrailingSlash(baseUrl)), {
    headers: authHeaders(apiKey)
  })
  if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return (payload.data ?? []).flatMap((model) => (model.id ? [model.id] : []))
}

async function probeStreaming(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null
): Promise<Pick<AgentLocalProviderProbeResult, 'streamingSupported' | 'detail'>> {
  try {
    const response = await fetchImpl(
      new URL('chat/completions', ensureTrailingSlash(settings.baseUrl)),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(apiKey)
        },
        signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: settings.model,
          stream: true,
          messages: [{ role: 'user', content: 'Reply with ok.' }]
        })
      }
    )
    if (!response.ok)
      throw new Error(`/v1/chat/completions streaming returned HTTP ${response.status}`)
    if (!response.body) {
      return { streamingSupported: false, detail: 'Streaming response body was empty.' }
    }
    const chunk = await readFirstStreamChunk(response.body)
    return {
      streamingSupported: Boolean(chunk),
      detail: chunk ? null : 'Streaming response ended before sending a chunk.'
    }
  } catch (error) {
    return { streamingSupported: false, detail: errorMessage(error) }
  }
}

async function probeToolCalling(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null
): Promise<ToolProbe> {
  const request = {
    model: settings.model,
    messages: [PROBE_USER_MESSAGE],
    tools: [
      {
        type: 'function',
        function: {
          name: PROBE_TOOL_NAME,
          description: 'Echo a probe string.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false
          }
        }
      }
    ]
  }

  let first: ChatCompletion
  let toolChoice: ToolCallProfile['toolChoice'] = 'auto'
  try {
    first = await postChatCompletion(settings, fetchImpl, apiKey, {
      ...request,
      tool_choice: { type: 'function', function: { name: PROBE_TOOL_NAME } }
    })
  } catch {
    // DeepSeek in thinking mode answers a named tool_choice with HTTP 400 although it
    // calls tools fine without one (#2609). The chat then sends no tool_choice either.
    toolChoice = 'omit'
    try {
      first = await postChatCompletion(settings, fetchImpl, apiKey, request)
    } catch (error) {
      const detail = errorMessage(error)
      return { ok: false, reason: 'tools_rejected', called: false, detail, providerDetail: detail }
    }
  }

  const assistant = first.choices?.[0]?.message
  const nativeCall = assistant?.tool_calls?.[0]
  const replay = nativeCall?.id ? { assistant, callId: nativeCall.id } : textCallReplay(assistant)
  if (!replay) {
    return {
      ok: false,
      reason: 'no_tool_call',
      called: false,
      detail: `Model did not emit the synthetic ${PROBE_TOOL_NAME} tool call.`,
      providerDetail: null
    }
  }

  try {
    const second = await postChatCompletion(settings, fetchImpl, apiKey, {
      model: settings.model,
      messages: [
        PROBE_USER_MESSAGE,
        replay.assistant,
        {
          role: 'tool',
          tool_call_id: replay.callId,
          content: JSON.stringify({ ok: true, data: { text: 'ok' } })
        }
      ]
    })
    if (!second.choices?.[0]?.message) {
      return {
        ok: false,
        reason: 'tool_result_rejected',
        called: true,
        detail: 'Model returned no message after the tool result.',
        providerDetail: null
      }
    }
  } catch (error) {
    const detail = errorMessage(error)
    return {
      ok: false,
      reason: 'tool_result_rejected',
      called: true,
      detail,
      providerDetail: detail
    }
  }
  return { ok: true, profile: { toolChoice, toolCalls: nativeCall?.id ? 'native' : 'text' } }
}

/** True when the server answers a request that carries an image; any error is a no. */
async function probeImageInput(
  settings: AgentLocalProviderSettings,
  model: string,
  fetchImpl: typeof fetch,
  apiKey: string | null
): Promise<boolean> {
  try {
    await postChatCompletion(settings, fetchImpl, apiKey, {
      model,
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with ok.' },
            { type: 'image_url', image_url: { url: PROBE_IMAGE_URL } }
          ]
        }
      ]
    })
    return true
  } catch (error) {
    logger.warn(`Image input probe failed for model ${model}: ${errorMessage(error)}`)
    return false
  }
}

/**
 * A model whose server leaves its tool call in the reply text gets that call back as a
 * structured `tool_calls` entry, which is what the chat sends after the text is parsed.
 */
function textCallReplay(
  assistant: ChatCompletionMessage | undefined
): { assistant: ChatCompletionMessage; callId: string } | null {
  if (typeof assistant?.content !== 'string') return null
  const splitter = new TextToolCallSplitter(new Set([PROBE_TOOL_NAME]))
  const segments = [...splitter.push(assistant.content), ...splitter.flush()]
  const call = segments.find((segment) => segment.kind === 'call')?.call
  if (!call) return null
  const text = segments
    .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
    .join('')
  const callId = 'probe-text-call'
  return {
    callId,
    assistant: {
      ...assistant,
      content: text.trim() ? text : null,
      tool_calls: [
        { id: callId, type: 'function', function: { name: call.toolName, arguments: call.input } }
      ]
    }
  }
}

interface ChatCompletionMessage {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface ChatCompletion {
  choices?: Array<{ message?: ChatCompletionMessage }>
}

async function postChatCompletion(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null,
  body: unknown
): Promise<ChatCompletion> {
  const response = await fetchImpl(
    new URL('chat/completions', ensureTrailingSlash(settings.baseUrl)),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(apiKey)
      },
      signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
      body: JSON.stringify(body)
    }
  )
  if (!response.ok) {
    throw new Error(
      `/v1/chat/completions returned HTTP ${response.status}${await providerErrorSuffix(response)}`
    )
  }
  return response.json()
}

// OpenAI-style error bodies carry the provider's own reason, which the chat shows when
// it turns tools off. Anything else (HTML, plain text) is dropped.
async function providerErrorSuffix(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string }
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    return typeof message === 'string' && message.trim() ? `: ${message.trim()}` : ''
  } catch {
    return ''
  }
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

async function readFirstStreamChunk(body: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = body.getReader()
  try {
    const { done, value } = await reader.read()
    return !done && Boolean(value?.byteLength)
  } finally {
    reader.releaseLock()
  }
}

function toToolError(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as { code?: unknown; message?: unknown }
  return {
    code: typeof input.code === 'string' ? input.code : 'TOOL_ERROR',
    message: typeof input.message === 'string' ? input.message : 'Tool call failed.'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
