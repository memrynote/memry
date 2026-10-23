import type { AgentBackendId, AgentBackendOptions } from '@memry/contracts/ipc-agent'
import type { FoldAgentChoice, FoldAgentStatus } from '@memry/contracts/note-fold'

import { getActiveBackends } from '../agent/backends/active-registry'
import { getLocalProviderSettings } from '../agent/backends/local-provider-settings'
import { completeStructured } from '../agent/backends/structured-completion'
import { ensureLazyAgentServicesStarted } from '../agent/lazy-services'
import { createLogger } from '../lib/logger'
import type { AgentBackend } from '../agent/backends/types'
import type { FoldAgent } from './fold-service'

const logger = createLogger('NoteFold:Agent')

/** Detection order: the CLIs first, the local provider last (it is a network probe). */
const CANDIDATES: Array<{ id: AgentBackendId; label: string; options: AgentBackendOptions }> = [
  { id: 'claude_cli', label: 'Claude', options: { backend: 'claude_cli', claudeEffort: 'low' } },
  { id: 'codex_cli', label: 'Codex', options: { backend: 'codex_cli', reasoningEffort: 'low' } },
  { id: 'antigravity_cli', label: 'Antigravity', options: { backend: 'antigravity_cli' } },
  {
    id: 'local_openai_compatible',
    label: 'Local model',
    options: { backend: 'local_openai_compatible' }
  }
]

const DETECTED_TTL_MS = 60_000
/** "No agent" is not cached for long: connecting one in Settings must show up within seconds. */
const NONE_TTL_MS = 5_000

interface Detected {
  candidate: (typeof CANDIDATES)[number]
  backend: AgentBackend
  model: string | undefined
}

let cached: { at: number; found: Detected[] } | null = null
let inflight: Promise<Detected[]> | null = null

export function resetFoldAgentDetection(): void {
  cached = null
}

/**
 * The agent a run uses. `auto` is the first detected agent in CANDIDATES order;
 * a chosen agent that is not detected yields null (no_agent), never another one.
 */
export async function resolveFoldAgent(choice: FoldAgentChoice): Promise<FoldAgent | null> {
  const found = await detectAvailable()
  const hit = choice === 'auto' ? found[0] : found.find((d) => d.candidate.id === choice)
  return hit ? toFoldAgent(hit) : null
}

export async function getFoldAgentStatus(choice: FoldAgentChoice): Promise<FoldAgentStatus> {
  const found = await detectAvailable()
  const hit = choice === 'auto' ? found[0] : found.find((d) => d.candidate.id === choice)
  return {
    choice,
    available: found.map((d) => ({ id: d.candidate.id, label: d.candidate.label })),
    resolved: hit?.candidate.label ?? null
  }
}

function detectAvailable(): Promise<Detected[]> {
  if (cached) {
    const ttl = cached.found.length > 0 ? DETECTED_TTL_MS : NONE_TTL_MS
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.found)
  }
  inflight ??= detect()
    .then((found) => {
      cached = { at: Date.now(), found }
      return found
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function toFoldAgent({ candidate, backend, model }: Detected): FoldAgent {
  const options: AgentBackendOptions =
    candidate.options.backend === 'local_openai_compatible' && model
      ? { ...candidate.options, model }
      : candidate.options
  return {
    label: candidate.label,
    modelId: `${candidate.id}:${model ?? 'default'}`,
    run: (prompt, schema) => completeStructured({ backend, options, prompt, schema })
  }
}

async function detect(): Promise<Detected[]> {
  try {
    // The backend registry only exists once the agent runtime has started
    // (startAgent builds it together with the CLI spawn adapters), and that
    // runtime starts only behind the lazy services, which also start the Agent
    // MCP server. There is no registry-only entry point, so detection starts
    // both; splitting startAgent from the MCP lifecycle is a separate change.
    await ensureLazyAgentServicesStarted()
  } catch (error) {
    logger.warn('Agent services unavailable for note fold', error)
    return []
  }
  const registry = getActiveBackends()
  if (!registry) return []

  const probed = await Promise.all(
    CANDIDATES.map(async (candidate): Promise<Detected | null> => {
      const backend = registry.get(candidate.id)
      try {
        if (!(await backend.getStatus()).available) return null
      } catch (error) {
        logger.warn('Backend detection failed', { backend: candidate.id, error })
        return null
      }
      const model =
        candidate.id === 'local_openai_compatible'
          ? (await getLocalProviderSettings()).model || undefined
          : undefined
      return { candidate, backend, model }
    })
  )
  return probed.filter((d): d is Detected => d !== null)
}
