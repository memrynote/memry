import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOllama } from 'ollama-ai-provider-v2'
import {
  type AgentBackendOptions,
  type AgentBackendStatus,
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings,
  type AgentLocalThinking,
  type LocalReasoningEffort
} from '@memry/contracts/ipc-agent'
import { type JSONValue, stepCountIs, streamText, wrapLanguageModel } from 'ai'

import type { BackendEvent } from '../cli/types'
import { AgentToolBridge, createAiSdkToolSet } from './tool-bridge'
import {
  errorMessage,
  type LocalProbe,
  probeImageInput,
  probeLocalProvider,
  probeSettingsKey,
  testOpenAiCompatibleConnection
} from './local-provider-probe'
import { toolCallProfileMiddleware, type ToolCallProfile } from './tool-call-profile'
import { toolImageMiddleware } from './tool-images'
import type { TurnWriteGrant } from '../turn-grants'
import type {
  AgentBackend,
  AgentBackendRunInput,
  AgentBackendTurnInput,
  BackendRunHandle
} from './types'

let nextLocalRunPid = -1

// ponytail: fixed 8192-token window fixes #591. Ollama's default context is 4096
// and OLLAMA_NUM_PARALLEL divides it across slots, so Memry's system prompt + tool
// schemas overflow and the reply is cut to one token. Promote to a user setting only
// if someone needs to tune it.
const OLLAMA_NUM_CTX = 8192

// The image-input probe's answer can change when the provider swaps the model behind a
// name, so it expires; a "no" expires faster because a provider error looks the same.
const PROBE_TTL_MS = 10 * 60_000
const PROBE_DEGRADED_TTL_MS = 60_000
// Used when a transient provider error leaves the tool probe without an answer and no
// earlier pass is known for this configuration.
const DEFAULT_TOOL_PROFILE: ToolCallProfile = { toolChoice: 'auto' }

// Model calls per turn with tools. The last one runs without tools and asks for a
// handoff, so a turn cut off at the limit still ends in an answer (AF-032).
const STEP_LIMIT = 24
const STEP_BUDGET_SYSTEM =
  `You can make at most ${STEP_LIMIT} model calls in this turn, and each tool round uses one. ` +
  'Plan the work to fit, and answer before the budget runs out.'
const HANDOFF_SYSTEM =
  'This is the last model call of this turn: the step limit is reached, and tools are off for this call. ' +
  'Do not write tool calls or tool syntax. Answer in plain text with a short handoff: ' +
  'what is done, what is left, and what the user should send to continue.'

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
  } | null = null
  private probeInFlight: {
    settingsKey: string
    apiKey: string | null
    promise: Promise<LocalProbe>
  } | null = null
  // The probe turnHasTools answered from, kept for the run that follows so a transient
  // answer, which is never cached, is not probed a second time. Taken once.
  private turnProbe: { settingsKey: string; apiKey: string | null; probe: LocalProbe } | null = null
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

  async turnHasTools(options: AgentBackendOptions): Promise<boolean> {
    if (options.backend === this.id && options.toolsEnabled === false) return false
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey()
    const probe = await this.resolveProbe(settings, apiKey)
    this.turnProbe = { settingsKey: probeSettingsKey(settings), apiKey, probe }
    return probe.tools.kind === 'on'
  }

  private async turnTools(
    settings: AgentLocalProviderSettings,
    apiKey: string | null
  ): Promise<LocalProbe['tools']> {
    const reserved = this.turnProbe
    this.turnProbe = null
    if (reserved?.settingsKey === probeSettingsKey(settings) && reserved.apiKey === apiKey) {
      return reserved.probe.tools
    }
    return (await this.resolveProbe(settings, apiKey)).tools
  }

  private async resolveProbe(
    settings: AgentLocalProviderSettings,
    apiKey: string | null,
    options: { force?: boolean } = {}
  ): Promise<LocalProbe> {
    const settingsKey = probeSettingsKey(settings)
    if (!options.force) {
      const cached = this.probeCache
      if (cached?.settingsKey === settingsKey && cached.apiKey === apiKey) return cached.probe
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
    const run = await probeLocalProvider(settings, this.deps.fetch ?? fetch, apiKey)
    if (run.tools.kind === 'transient') {
      // Not cached: the next turn probes again. This turn keeps its tools, and if the
      // provider still fails, the turn shows that error instead of quietly losing tools.
      const cached = this.probeCache
      const known =
        cached?.settingsKey === settingsKey &&
        cached.apiKey === apiKey &&
        cached.probe.tools.kind === 'on'
          ? cached.probe.tools.profile
          : DEFAULT_TOOL_PROFILE
      return { result: run.result, tools: { kind: 'on', profile: known } }
    }
    const probe = { result: run.result, tools: run.tools }
    // A pass or a model verdict holds until the preset, base URL, model or key changes,
    // or the app restarts; the settings screen's forced probe refreshes it. Unreachable
    // provider, missing model and no streaming are fixed outside the app and cost no
    // tool probe, so they are never cached and starting the server takes effect next turn.
    const cacheable =
      probe.result.connected && probe.result.modelAvailable && probe.result.streamingSupported
    this.probeCache = cacheable ? { settingsKey, apiKey, probe } : null
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
        ? await this.turnTools(settings, apiKey)
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
      abortSignal: controller.signal,
      stopWhen: stepCountIs(STEP_LIMIT),
      ...(tools?.kind === 'on'
        ? {
            system: STEP_BUDGET_SYSTEM,
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber === STEP_LIMIT - 1
                ? { activeTools: [], system: HANDOFF_SYSTEM }
                : undefined
          }
        : {}),
      ...(isOllama
        ? { providerOptions: { ollama: { options: { num_ctx: OLLAMA_NUM_CTX } } } }
        : reasoningProviderOptions(options?.reasoningEffort, settings.thinking)),
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

// Fields go out only for a non-default pick, because other OpenAI-compatible servers
// may reject fields they do not know. The provider copies unknown keys, such as
// DeepSeek's `thinking`, into the request body as-is.
function reasoningProviderOptions(
  effort: LocalReasoningEffort | undefined,
  thinking: AgentLocalThinking | undefined
): { providerOptions?: { 'local-openai-compatible': Record<string, JSONValue> } } {
  const fields: Record<string, JSONValue> = {
    ...(effort && effort !== 'default' ? { reasoningEffort: effort } : {}),
    ...(thinking === 'off' ? { thinking: { type: 'disabled' } } : {})
  }
  return Object.keys(fields).length > 0
    ? { providerOptions: { 'local-openai-compatible': fields } }
    : {}
}

async function* mapAiSdkEvents(
  leading: BackendEvent[],
  stream: AsyncIterable<unknown>,
  onError: (error: unknown) => void
): AsyncIterable<BackendEvent> {
  yield* leading
  let finishedSteps = 0
  try {
    for await (const part of stream) {
      if (isPart(part, 'finish-step')) finishedSteps += 1
      if (isPart(part, 'finish') && finishedSteps >= STEP_LIMIT) yield { kind: 'step_limit' }
      const event = partToBackendEvent(part)
      if (event) yield event
    }
  } catch (error) {
    onError(error)
  }
}

function isPart(part: unknown, type: string): boolean {
  return !!part && typeof part === 'object' && 'type' in part && part.type === type
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

function toToolError(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as { code?: unknown; message?: unknown }
  return {
    code: typeof input.code === 'string' ? input.code : 'TOOL_ERROR',
    message: typeof input.message === 'string' ? input.message : 'Tool call failed.'
  }
}
