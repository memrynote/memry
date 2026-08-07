import { createOpenAI } from '@ai-sdk/openai'
import { createOllama } from 'ollama-ai-provider-v2'
import {
  type AgentBackendStatus,
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings
} from '@memry/contracts/ipc-agent'
import { stepCountIs, streamText } from 'ai'

import type { BackendEvent } from '../cli/types'
import { AgentToolBridge, createAiSdkToolSet } from './tool-bridge'
import type { AgentBackend, AgentBackendRunInput, BackendRunHandle } from './types'

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
    result: AgentLocalProviderProbeResult
    expiresAt: number
  } | null = null
  private probeInFlight: {
    settingsKey: string
    apiKey: string | null
    promise: Promise<AgentLocalProviderProbeResult>
  } | null = null

  constructor(
    private readonly deps: {
      getSettings: () => Promise<AgentLocalProviderSettings>
      getApiKey: () => Promise<string | null>
      toolBridge: AgentToolBridge
      fetch?: typeof fetch
    }
  ) {}

  async runTurn(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, true)
  }

  async generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, false)
  }

  async summarize(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, false)
  }

  cancel(conversationId: string): void {
    void conversationId
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
    return this.resolveProbe(settings, apiKey, { force: true })
  }

  private async resolveProbe(
    settings: AgentLocalProviderSettings,
    apiKey: string | null,
    options: { force?: boolean } = {}
  ): Promise<AgentLocalProviderProbeResult> {
    const settingsKey = probeSettingsKey(settings)
    if (!options.force) {
      const cached = this.probeCache
      if (
        cached?.settingsKey === settingsKey &&
        cached.apiKey === apiKey &&
        cached.expiresAt > Date.now()
      ) {
        return cached.result
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
  ): Promise<AgentLocalProviderProbeResult> {
    const result = await probeLocalProvider(settings, this.deps.fetch ?? fetch, apiKey)
    const ttl = probeCacheTtlMs(result)
    this.probeCache = ttl > 0 ? { settingsKey, apiKey, result, expiresAt: Date.now() + ttl } : null
    return result
  }

  private async run(input: AgentBackendRunInput, allowTools: boolean): Promise<BackendRunHandle> {
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
      : createOpenAI({
          baseURL: settings.baseUrl,
          apiKey: apiKey || 'local'
        }).chat(modelName)
    const controller = new AbortController()
    const toolsEnabled =
      allowTools &&
      (options?.toolsEnabled ?? true) &&
      (await this.resolveProbe(settings, apiKey)).toolsEnabled
    const result = streamText({
      model,
      prompt: input.prompt,
      abortSignal: controller.signal,
      stopWhen: stepCountIs(8),
      ...(isOllama
        ? { providerOptions: { ollama: { options: { num_ctx: OLLAMA_NUM_CTX } } } }
        : {}),
      ...(toolsEnabled
        ? {
            tools: createAiSdkToolSet(this.deps.toolBridge, {
              conversationId: input.conversationId,
              windowId: input.windowId
            })
          }
        : {})
    })
    let exitCode = 0
    let stderr = ''

    return {
      events: mapAiSdkEvents(result.fullStream, (error) => {
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
  stream: AsyncIterable<unknown>,
  onError: (error: unknown) => void
): AsyncIterable<BackendEvent> {
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
): Promise<AgentLocalProviderProbeResult> {
  const connection = await testOpenAiCompatibleConnection(settings, fetchImpl, apiKey)
  if (!connection.connected || !connection.modelAvailable) return connection

  const streaming = await probeStreaming(settings, fetchImpl, apiKey)
  if (!streaming.streamingSupported) {
    return {
      ...connection,
      ...streaming,
      toolsEnabled: false
    }
  }

  const toolProbe = await probeToolCalling(settings, fetchImpl, apiKey)
  return {
    ...connection,
    ...streaming,
    ...toolProbe,
    toolsEnabled:
      streaming.streamingSupported &&
      toolProbe.toolCallingSupported &&
      toolProbe.toolContinuationSupported
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
): Promise<
  Pick<
    AgentLocalProviderProbeResult,
    'toolCallingSupported' | 'toolContinuationSupported' | 'detail'
  >
> {
  try {
    const first = await postChatCompletion(settings, fetchImpl, apiKey, {
      model: settings.model,
      messages: [{ role: 'user', content: 'Call the echo tool with text "ok".' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'memry_probe_echo',
            description: 'Echo a probe string.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'memry_probe_echo' } }
    })
    const assistant = first.choices?.[0]?.message
    const toolCall = assistant?.tool_calls?.[0]
    if (!toolCall?.id) {
      return {
        toolCallingSupported: false,
        toolContinuationSupported: false,
        detail: 'Model did not emit the synthetic memry_probe_echo tool call.'
      }
    }

    const second = await postChatCompletion(settings, fetchImpl, apiKey, {
      model: settings.model,
      messages: [
        { role: 'user', content: 'Call the echo tool with text "ok".' },
        assistant,
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: true, data: { text: 'ok' } })
        }
      ]
    })
    return {
      toolCallingSupported: true,
      toolContinuationSupported: Boolean(second.choices?.[0]?.message),
      detail: null
    }
  } catch (error) {
    return {
      toolCallingSupported: false,
      toolContinuationSupported: false,
      detail: errorMessage(error)
    }
  }
}

async function postChatCompletion(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null,
  body: unknown
): Promise<{
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}> {
  const response = await fetchImpl(
    new URL('chat/completions', ensureTrailingSlash(settings.baseUrl)),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(apiKey)
      },
      body: JSON.stringify(body)
    }
  )
  if (!response.ok) throw new Error(`/v1/chat/completions returned HTTP ${response.status}`)
  return response.json()
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
