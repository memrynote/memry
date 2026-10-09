// Pre-release smoke check of the built-in agent backend against a real OpenAI-compatible
// provider (FB-016). It runs the app's own probe and backend, so the requests match the
// shipped build. Usage:
//
//   MEMRY_SMOKE_BASE_URL=https://api.deepseek.com/v1 MEMRY_SMOKE_MODEL=deepseek-v4-flash \
//   MEMRY_SMOKE_API_KEY=... pnpm --filter @memry/desktop smoke:local-provider
//
// Prints PASS or FAIL per check and exits 1 when any check fails. The key is never printed.
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type {
  AgentLocalProviderSettings,
  AgentLocalThinking,
  LocalReasoningEffort
} from '@memry/contracts/ipc-agent'

import { LocalOpenAICompatibleBackend } from '../src/main/agent/backends/local-openai-compatible-backend'
import { probeLocalProvider } from '../src/main/agent/backends/local-provider-probe'
import type { BackendEvent } from '../src/main/agent/cli/types'
import type { TurnWriteGrant } from '../src/main/agent/turn-grants'

// The app logger writes to the user's Memry log folder unless this is set.
process.env.MEMRY_TEST_LOG_DIR ??= join(tmpdir(), 'memry-smoke-local-provider')

const baseUrl = process.env.MEMRY_SMOKE_BASE_URL
const model = process.env.MEMRY_SMOKE_MODEL
const apiKey = process.env.MEMRY_SMOKE_API_KEY || null
if (!baseUrl || !model) {
  console.error(
    'Set MEMRY_SMOKE_BASE_URL and MEMRY_SMOKE_MODEL (and MEMRY_SMOKE_API_KEY if the provider needs one).'
  )
  process.exit(2)
}

function redact(text: string): string {
  return apiKey ? text.split(apiKey).join('[key]') : text
}

function settings(thinking: AgentLocalThinking = 'default'): AgentLocalProviderSettings {
  return {
    preset: 'custom',
    baseUrl: baseUrl!,
    model: model!,
    apiKeyConfigured: apiKey !== null,
    allowNonLoopback: true,
    thinking
  }
}

const TAGS = { tags: [{ name: 'memry-smoke', count: 1 }] }

async function turn(input: {
  prompt: string
  toolsEnabled: boolean
  thinking?: AgentLocalThinking
  reasoningEffort?: LocalReasoningEffort
}): Promise<{ events: BackendEvent[]; exitCode: number; stderr: string; toolCalls: string[] }> {
  const toolCalls: string[] = []
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => settings(input.thinking),
    getApiKey: async () => apiKey,
    toolBridge: {
      execute: async ({ name }: { name: string }) => {
        toolCalls.push(name)
        return { ok: true as const, data: TAGS }
      }
    } as never
  })
  const run = await backend.runTurn({
    conversationId: 'smoke',
    writeGrant: 'smoke-grant' as TurnWriteGrant,
    windowId: 'smoke',
    prompt: input.prompt,
    options: {
      backend: 'local_openai_compatible',
      model: model!,
      toolsEnabled: input.toolsEnabled,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    }
  })
  const events: BackendEvent[] = []
  for await (const event of run.events) events.push(event)
  let stderr = ''
  for await (const piece of run.stderr ?? []) stderr += piece.toString()
  return { events, exitCode: await run.waitExit(), stderr, toolCalls }
}

function text(events: BackendEvent[], kind: 'assistant_delta' | 'reasoning_delta'): string {
  return events.map((event) => (event.kind === kind ? event.text : '')).join('')
}

function turnError(result: Awaited<ReturnType<typeof turn>>): string | null {
  const error = result.events.find((event) => event.kind === 'error')
  if (error?.kind === 'error') return error.message
  if (result.exitCode !== 0) return result.stderr || `exit code ${result.exitCode}`
  return null
}

let failed = 0
function report(name: string, problem: string | null, detail = ''): void {
  if (problem) failed += 1
  const suffix = problem ?? detail
  console.log(`${problem ? 'FAIL' : 'PASS'}  ${name}${suffix ? `: ${redact(suffix)}` : ''}`)
}

async function check(
  name: string,
  body: () => Promise<{ problem: string | null; detail?: string }>
): Promise<void> {
  try {
    const { problem, detail } = await body()
    report(name, problem, detail)
  } catch (error) {
    report(name, error instanceof Error ? error.message : String(error))
  }
}

async function main(): Promise<void> {
  console.log(`Smoke check: model ${model} at ${baseUrl}`)

  await check('probe', async () => {
    const run = await probeLocalProvider(settings(), fetch, apiKey)
    if (run.tools.kind === 'on')
      return { problem: null, detail: `tools on, tool_choice ${run.tools.profile.toolChoice}` }
    return { problem: run.result.detail ?? `tools ${run.tools.kind}` }
  })

  const tagsPrompt = 'User: Call the vault_get_tags tool once, then tell me how many tags I have.'
  let toolTurn: Awaited<ReturnType<typeof turn>> | null = null
  await check('tool round trip', async () => {
    toolTurn = await turn({ prompt: tagsPrompt, toolsEnabled: true })
    const error = turnError(toolTurn)
    if (error) return { problem: error }
    if (toolTurn.events.some((event) => event.kind === 'tools_unavailable'))
      return { problem: 'tools were turned off' }
    if (!toolTurn.toolCalls.includes('vault_get_tags'))
      return { problem: 'the model did not call vault_get_tags' }
    if (!text(toolTurn.events, 'assistant_delta').trim())
      return { problem: 'no answer after the tool result' }
    return { problem: null, detail: `tools called: ${toolTurn.toolCalls.join(', ')}` }
  })

  await check('reasoning', async () => {
    if (!toolTurn) return { problem: 'needs the tool round trip' }
    const reasoning = text(toolTurn.events, 'reasoning_delta')
    if (!reasoning.trim()) return { problem: 'the tool turn streamed no reasoning' }
    return {
      problem: null,
      detail: `${reasoning.length} characters of reasoning, kept through the tool loop`
    }
  })

  const optionalFields: Array<{
    name: string
    thinking?: AgentLocalThinking
    reasoningEffort?: LocalReasoningEffort
  }> = [
    { name: 'reasoning_effort high', reasoningEffort: 'high' },
    { name: 'reasoning_effort max', reasoningEffort: 'max' },
    { name: 'thinking disabled', thinking: 'off' }
  ]
  for (const field of optionalFields) {
    await check(`accepts ${field.name}`, async () => {
      const result = await turn({ prompt: 'User: Reply with ok.', toolsEnabled: false, ...field })
      const error = turnError(result)
      if (error) return { problem: error }
      return { problem: text(result.events, 'assistant_delta').trim() ? null : 'empty answer' }
    })
  }

  console.log(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
