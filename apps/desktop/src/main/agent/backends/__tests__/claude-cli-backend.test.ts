import { DEFAULT_CLAUDE_EFFORT } from '@memry/contracts/ipc-agent'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectClaudeBinary: vi.fn(async () => ({
    detected: true,
    version: '2.0.0',
    meetsMinimum: true,
    minimumRequired: '1.0.0',
    installHint: null
  }))
}))

vi.mock('../../cli/claude-binary', () => ({
  detectClaudeBinary: mocks.detectClaudeBinary
}))

import { ClaudeCliBackend } from '../claude-cli-backend'

describe('ClaudeCliBackend', () => {
  it('spawns Claude turns and parses JSONL backend events', async () => {
    const spawn = vi.fn(async () =>
      createHandle(
        [
          JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Creating ' }
          }),
          JSON.stringify({
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              id: 'tool-1',
              name: 'vault_create_task',
              input: { title: 'Claude task' }
            }
          }),
          JSON.stringify({
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: '{"id":"task-1"}' }]
          }),
          JSON.stringify({ type: 'message_stop' })
        ].join('\n')
      )
    )
    const backend = new ClaudeCliBackend({ spawn })

    const run = await backend.runTurn({
      prompt: 'User: create a task',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'claude_cli', claudeEffort: 'high', model: 'sonnet' }
    })

    const events = []
    for await (const event of run.events) events.push(event)

    expect(spawn).toHaveBeenCalledWith({
      prompt: 'User: create a task',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      effort: 'high',
      model: 'sonnet',
      purpose: 'turn'
    })
    expect(events).toEqual([
      { kind: 'assistant_delta', text: 'Creating ' },
      {
        kind: 'tool_use',
        toolUseId: 'tool-1',
        name: 'vault_create_task',
        args: { title: 'Claude task' }
      },
      { kind: 'tool_result', toolUseId: 'tool-1', ok: true, data: { id: 'task-1' } },
      { kind: 'message_stop' }
    ])
  })

  it('marks title and summary runs with tool-free purposes', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new ClaudeCliBackend({ spawn })

    await backend.generateTitle({
      prompt: 'Title this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'claude_cli', claudeEffort: 'low', model: 'opus' }
    })
    await backend.summarize({
      prompt: 'Summarize this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'medium' }
    })

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ purpose: 'title', model: 'opus' })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ purpose: 'summary', effort: DEFAULT_CLAUDE_EFFORT })
    )
  })

  it('forwards turn permissions to the Claude subprocess adapter', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new ClaudeCliBackend({ spawn })

    await backend.runTurn({
      prompt: 'User: inspect',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'claude_cli', claudeEffort: 'low' },
      permissions: { accessMode: 'computer_access', webSearchEnabled: true }
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { accessMode: 'computer_access', webSearchEnabled: true }
      })
    )
  })

  it('reports Claude CLI availability through the unified backend status shape', async () => {
    const backend = new ClaudeCliBackend({ spawn: vi.fn() })

    await expect(backend.getStatus()).resolves.toEqual({
      backend: 'claude_cli',
      available: true,
      reason: null,
      detail: null,
      version: '2.0.0',
      minimumRequired: '1.0.0'
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
