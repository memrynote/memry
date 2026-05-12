import { describe, expect, it, vi } from 'vitest'

import { createAgentBackendRegistry } from '../registry'

describe('agent backend registry', () => {
  it('registers the long-term backend ids behind one shared contract', async () => {
    const claude = {
      id: 'claude_cli' as const,
      runTurn: vi.fn(),
      generateTitle: vi.fn(),
      summarize: vi.fn(),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ available: true })),
      probeCapabilities: vi.fn()
    }
    const local = {
      id: 'local_openai_compatible' as const,
      runTurn: vi.fn(),
      generateTitle: vi.fn(),
      summarize: vi.fn(),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ available: true })),
      probeCapabilities: vi.fn()
    }
    const codex = {
      id: 'codex_cli' as const,
      runTurn: vi.fn(),
      generateTitle: vi.fn(),
      summarize: vi.fn(),
      cancel: vi.fn(),
      getStatus: vi.fn(async () => ({ available: true })),
      probeCapabilities: vi.fn()
    }

    const registry = createAgentBackendRegistry({ claude, codex, local })

    expect(registry.get('claude_cli')).toBe(claude)
    expect(registry.get('local_openai_compatible')).toBe(local)
    expect(registry.get('codex_cli')).toBe(codex)
    expect(() => registry.get('ollama' as never)).toThrow(/Unknown agent backend/)
  })
})
