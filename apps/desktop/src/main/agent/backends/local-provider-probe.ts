import {
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings,
  type AgentToolsOffReason
} from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import { TextToolCallSplitter, type ToolCallProfile } from './tool-call-profile'

const logger = createLogger('Agent:LocalProvider')

// Long enough for a slow local thinking model to finish the tool probe's two generations.
const PROBE_REQUEST_TIMEOUT_MS = 120_000

const PROBE_TOOL_NAME = 'memry_probe_echo'
// One white pixel: enough for a text-only model or server to refuse image input.
const PROBE_IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const PROBE_USER_MESSAGE = { role: 'user', content: 'Call the echo tool with text "ok".' }

/**
 * What the probe decided about tools for one provider configuration. `detail` on `off`
 * is the provider's own error text and stays null when Memry only observed the model.
 */
export type ToolAccess =
  | { kind: 'on'; profile: ToolCallProfile }
  | { kind: 'off'; reason: AgentToolsOffReason; detail: string | null }
  | { kind: 'unreachable' }

export interface LocalProbe {
  result: AgentLocalProviderProbeResult
  tools: ToolAccess
}

/**
 * A probe run as observed. `transient` means the provider failed for a reason unrelated
 * to the model (network, timeout, 408, 429, 5xx), so the run says nothing about tools.
 */
export interface ProbeRun {
  result: AgentLocalProviderProbeResult
  tools: ToolAccess | { kind: 'transient' }
}

type ToolProbe =
  | { ok: true; profile: ToolCallProfile }
  | { ok: false; transient: true; detail: string }
  | {
      ok: false
      transient: false
      reason: Exclude<AgentToolsOffReason, 'streaming_unsupported'>
      called: boolean
      detail: string
      providerDetail: string | null
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

export async function probeLocalProvider(
  settings: AgentLocalProviderSettings,
  fetchImpl: typeof fetch,
  apiKey: string | null
): Promise<ProbeRun> {
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
  if (toolProbe.transient) {
    logger.warn(
      `Tool probe hit a transient error for model ${settings.model}, tools stay on: ${toolProbe.detail}`
    )
    return {
      result: {
        ...connection,
        ...streaming,
        toolsEnabled: true,
        detail: `Tool check hit a temporary provider error, tools stay on: ${toolProbe.detail}`
      },
      tools: { kind: 'transient' }
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
export function probeSettingsKey(settings: AgentLocalProviderSettings): string {
  return JSON.stringify([settings.preset, settings.baseUrl, settings.model])
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
  } catch (error) {
    if (isTransientError(error)) return { ok: false, transient: true, detail: errorMessage(error) }
    // DeepSeek in thinking mode answers a named tool_choice with HTTP 400 although it
    // calls tools fine without one (#2609). The chat then sends no tool_choice either.
    toolChoice = 'omit'
    try {
      first = await postChatCompletion(settings, fetchImpl, apiKey, request)
    } catch (error) {
      const detail = errorMessage(error)
      if (isTransientError(error)) return { ok: false, transient: true, detail }
      return {
        ok: false,
        transient: false,
        reason: 'tools_rejected',
        called: false,
        detail,
        providerDetail: detail
      }
    }
  }

  const assistant = first.choices?.[0]?.message
  const nativeCall = assistant?.tool_calls?.[0]
  const replay = nativeCall?.id ? { assistant, callId: nativeCall.id } : textCallReplay(assistant)
  if (!replay) {
    return {
      ok: false,
      transient: false,
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
        transient: false,
        reason: 'tool_result_rejected',
        called: true,
        detail: 'Model returned no message after the tool result.',
        providerDetail: null
      }
    }
  } catch (error) {
    const detail = errorMessage(error)
    if (isTransientError(error)) return { ok: false, transient: true, detail }
    return {
      ok: false,
      transient: false,
      reason: 'tool_result_rejected',
      called: true,
      detail,
      providerDetail: detail
    }
  }
  return { ok: true, profile: { toolChoice } }
}

/** True when the server answers a request that carries an image; any error is a no. */
export async function probeImageInput(
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
    throw new ProviderHttpError(
      response.status,
      `/v1/chat/completions returned HTTP ${response.status}${await providerErrorSuffix(response)}`
    )
  }
  return response.json()
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// fetch rejects with a TypeError when the connection fails and with a DOMException when
// the probe's timeout aborts it. Any other error is the provider's answer about the model.
function isTransientError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  )
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
