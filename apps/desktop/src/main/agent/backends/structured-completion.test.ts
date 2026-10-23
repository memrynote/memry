import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { BackendEvent } from '../cli/types'
import { completeStructured } from './structured-completion'
import type { AgentBackend } from './types'

function backendReplying(text: string, exitCode = 0): AgentBackend {
  async function* events(): AsyncIterable<BackendEvent> {
    yield { kind: 'assistant_delta', text }
  }
  return {
    id: 'claude_cli',
    summarize: async () => ({
      events: events(),
      pid: 1,
      kill: () => {},
      waitExit: async () => exitCode,
      cleanup: async () => {}
    })
  } as unknown as AgentBackend
}

const run = (backend: AgentBackend) =>
  completeStructured({
    backend,
    options: { backend: 'claude_cli', claudeEffort: 'low' },
    prompt: 'p',
    schema: z.object({ a: z.number() })
  })

describe('completeStructured', () => {
  it('reads the JSON object out of a fenced reply', async () => {
    await expect(run(backendReplying('Sure:\n```json\n{"a": 1, "s": "}"}\n```'))).resolves.toEqual({
      a: 1
    })
  })

  it('rejects invalid JSON, schema mismatches and failed runs', async () => {
    await expect(run(backendReplying('not json'))).rejects.toThrow()
    await expect(run(backendReplying('{"a": "x"}'))).rejects.toThrow()
    await expect(run(backendReplying('{"a": 1}', 1))).rejects.toThrow(/exited 1/)
  })
})
