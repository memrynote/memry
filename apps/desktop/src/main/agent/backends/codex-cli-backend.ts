import { detectCodexBinary } from '../cli/codex-binary'
import { createCodexStreamParser } from '../cli/codex-stream-parser'
import type { BackendEvent } from '../cli/types'
import type {
  AgentBackend,
  AgentBackendRunInput,
  BackendRunHandle,
  CodexCliSpawnInput,
  RawSubprocessHandle
} from './types'

export class CodexCliBackend implements AgentBackend {
  readonly id = 'codex_cli' as const

  constructor(
    private readonly deps: { spawn: (input: CodexCliSpawnInput) => Promise<RawSubprocessHandle> }
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
    const status = await detectCodexBinary()
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
    const reasoningEffort =
      input.options.backend === 'codex_cli' ? input.options.reasoningEffort : 'medium'
    const model = input.options.backend === 'codex_cli' ? input.options.model : undefined
    const subprocess = await this.deps.spawn({
      prompt: input.prompt,
      conversationId: input.conversationId,
      windowId: input.windowId,
      reasoningEffort,
      model,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      purpose
    })

    return {
      ...subprocess,
      events: parseCodexEvents(subprocess.stdout)
    }
  }
}

async function* parseCodexEvents(stdout: AsyncIterable<Buffer>): AsyncIterable<BackendEvent> {
  const events: BackendEvent[] = []
  const parser = createCodexStreamParser((event) => {
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
