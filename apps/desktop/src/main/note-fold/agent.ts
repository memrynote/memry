import type { AgentBackendId, AgentBackendOptions } from '@memry/contracts/ipc-agent'

import { getActiveBackends } from '../agent/backends/active-registry'
import { getLocalProviderSettings } from '../agent/backends/local-provider-settings'
import { completeStructured } from '../agent/backends/structured-completion'
import { ensureLazyAgentServicesStarted } from '../agent/lazy-services'
import { createLogger } from '../lib/logger'
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

const DETECTION_TTL_MS = 60_000

let cached: { at: number; agent: FoldAgent | null } | null = null

/**
 * The first agent backend the Agents tab would report as available. Detection
 * spawns binaries and probes the local provider, so it is cached briefly.
 */
export async function resolveFoldAgent(): Promise<FoldAgent | null> {
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.agent
  const agent = await detect()
  cached = { at: Date.now(), agent }
  return agent
}

export function resetFoldAgentDetection(): void {
  cached = null
}

async function detect(): Promise<FoldAgent | null> {
  try {
    await ensureLazyAgentServicesStarted()
  } catch (error) {
    logger.warn('Agent services unavailable for note fold', error)
    return null
  }
  const registry = getActiveBackends()
  if (!registry) return null

  for (const candidate of CANDIDATES) {
    const backend = registry.get(candidate.id)
    try {
      if (!(await backend.getStatus()).available) continue
    } catch (error) {
      logger.warn('Backend detection failed', { backend: candidate.id, error })
      continue
    }
    let model = 'model' in candidate.options ? candidate.options.model : undefined
    if (candidate.id === 'local_openai_compatible') {
      model = (await getLocalProviderSettings()).model || undefined
    }
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
  return null
}
