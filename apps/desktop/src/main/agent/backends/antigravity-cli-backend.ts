import { detectAgyBinary } from '../cli/agy-binary'
import { createAgyStreamParser } from '../cli/agy-stream-parser'
import type { BackendEvent } from '../cli/types'
import type { TurnWriteGrant } from '../turn-grants'
import type {
  AgentBackend,
  AgentBackendRunInput,
  AgentBackendTurnInput,
  AgyCliSpawnInput,
  BackendRunHandle,
  RawSubprocessHandle
} from './types'

export class AntigravityCliBackend implements AgentBackend {
  readonly id = 'antigravity_cli' as const

  constructor(
    private readonly deps: { spawn: (input: AgyCliSpawnInput) => Promise<RawSubprocessHandle> }
  ) {}

  async runTurn(input: AgentBackendTurnInput): Promise<BackendRunHandle> {
    return this.run(input, 'turn')
  }

  async generateTitle(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, 'title')
  }

  async summarize(input: AgentBackendRunInput): Promise<BackendRunHandle> {
    return this.run(input, 'summary')
  }

  async getStatus() {
    const status = await detectAgyBinary()
    return {
      backend: this.id,
      available: status.detected && status.meetsMinimum,
      reason: status.detected && status.meetsMinimum ? null : 'missing_binary',
      detail: status.installHint,
      version: status.version,
      minimumRequired: status.minimumRequired
    }
  }

  private async run(
    input: AgentBackendRunInput & { writeGrant?: TurnWriteGrant },
    purpose: 'turn' | 'summary' | 'title'
  ) {
    const model = input.options.backend === 'antigravity_cli' ? input.options.model : undefined
    const subprocess = await this.deps.spawn({
      prompt: input.prompt,
      ...(input.writeGrant ? { writeGrant: input.writeGrant } : {}),
      windowId: input.windowId,
      model,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      purpose
    })

    return {
      ...subprocess,
      events: parseAgyEvents(subprocess.stdout)
    }
  }
}

async function* parseAgyEvents(stdout: AsyncIterable<Buffer>): AsyncIterable<BackendEvent> {
  const events: BackendEvent[] = []
  const parser = createAgyStreamParser((event) => {
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
