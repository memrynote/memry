import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectCodexBinary: vi.fn(async () => ({
    detected: true,
    version: '0.130.0',
    meetsMinimum: true,
    minimumRequired: '0.130.0',
    installHint: null
  }))
}))

vi.mock('../../cli/codex-binary', () => ({
  detectCodexBinary: mocks.detectCodexBinary
}))

import { CodexCliBackend } from '../codex-cli-backend'

describe('CodexCliBackend', () => {
  it('spawns Codex turns and parses JSONL backend events', async () => {
    const spawn = vi.fn(async () =>
      createHandle('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\n')
    )
    const backend = new CodexCliBackend({ spawn })

    const run = await backend.runTurn({
      prompt: 'User: ping',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'high', model: 'gpt-5.5' }
    })

    const events = []
    for await (const event of run.events) events.push(event)

    expect(spawn).toHaveBeenCalledWith({
      prompt: 'User: ping',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      reasoningEffort: 'high',
      model: 'gpt-5.5',
      purpose: 'turn'
    })
    expect(events).toEqual([{ kind: 'assistant_delta', text: 'pong' }])
  })

  it('marks title and summary runs with tool-free purposes', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new CodexCliBackend({ spawn })

    await backend.generateTitle({
      prompt: 'Title this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'medium' }
    })
    await backend.summarize({
      prompt: 'Summarize this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'medium' }
    })

    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'title' }))
    expect(spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'summary' }))
  })

  it('forwards turn permissions to the Codex subprocess adapter', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new CodexCliBackend({ spawn })

    await backend.runTurn({
      prompt: 'User: inspect',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'medium' },
      permissions: { accessMode: 'computer_access', webSearchEnabled: true }
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { accessMode: 'computer_access', webSearchEnabled: true }
      })
    )
  })

  it('reports Codex CLI availability through the unified backend status shape', async () => {
    const backend = new CodexCliBackend({ spawn: vi.fn() })

    await expect(backend.getStatus()).resolves.toEqual({
      backend: 'codex_cli',
      available: true,
      reason: null,
      detail: null,
      version: '0.130.0',
      minimumRequired: '0.130.0'
    })
  })
})

function createHandle(stdout: string) {
  return {
    stdout: (async function* () {
      yield Buffer.from(stdout)
    })(),
    stderr: (async function* () {})(),
    pid: 123,
    kill: vi.fn(),
    waitExit: vi.fn(async () => 0),
    cleanup: vi.fn(async () => {})
  }
}
