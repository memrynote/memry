import { DEFAULT_CLAUDE_EFFORT } from '@memry/contracts/ipc-agent'

import { detectClaudeBinary } from '../cli/claude-binary'
import { createStreamParser } from '../cli/stream-parser'
import type { BackendEvent } from '../cli/types'
import type {
  AgentBackend,
  AgentBackendRunInput,
  BackendRunHandle,
  ClaudeCliSpawnInput,
  RawSubprocessHandle
} from './types'

export class ClaudeCliBackend implements AgentBackend {
  readonly id = 'claude_cli' as const

  constructor(
    private readonly deps: { spawn: (input: ClaudeCliSpawnInput) => Promise<RawSubprocessHandle> }
  ) {}

  async runTurn(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, 'turn')
  }

  async generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, 'title')
  }

  async summarize(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, 'summary')
  }

  async getStatus() {
    const status = await detectClaudeBinary()
    return {
      backend: this.id,
      available: status.detected && status.meetsMinimum,
      reason: status.detected && status.meetsMinimum ? null : 'missing_binary',
      detail: status.installHint,
      version: status.version,
      minimumRequired: status.minimumRequired
    }
  }

  private async run(input: AgentBackendRunInput, purpose: 'turn' | 'summary' | 'title') {
    const effort =
      input.options.backend === 'claude_cli' ? input.options.claudeEffort : DEFAULT_CLAUDE_EFFORT
    const model = input.options.backend === 'claude_cli' ? input.options.model : undefined
    const subprocess = await this.deps.spawn({
      prompt: input.prompt,
      conversationId: input.conversationId,
      windowId: input.windowId,
      effort,
      model,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      purpose
    })

    return {
      ...subprocess,
      events: parseClaudeEvents(subprocess.stdout)
    }
  }
}

async function* parseClaudeEvents(stdout: AsyncIterable<Buffer>): AsyncIterable<BackendEvent> {
  const events: BackendEvent[] = []
  const parser = createStreamParser((event) => {
    events.push(event)
  })

  const drain = function* (): Iterable<BackendEvent> {
    while (events.length > 0) {
      const event = events.shift()
      if (event) yield event
    }
  }

  for await (const chunk of stdout) {
    parser.feed(chunk.toString('utf8'))
    yield* drain()
  }
  parser.flush()
  yield* drain()
}
