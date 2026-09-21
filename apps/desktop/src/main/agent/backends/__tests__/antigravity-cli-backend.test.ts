import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectAgyBinary: vi.fn(async () => ({
    detected: true,
    version: '1.2.7',
    meetsMinimum: true,
    minimumRequired: '1.2.7',
    installHint: null
  }))
}))

vi.mock('../../cli/agy-binary', () => ({
  detectAgyBinary: mocks.detectAgyBinary
}))

import { AntigravityCliBackend } from '../antigravity-cli-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'
const TEST_GRANT = 'turn-grant-1' as TurnWriteGrant

describe('AntigravityCliBackend', () => {
  it('spawns agy turns and parses NDJSON backend events', async () => {
    const spawn = vi.fn(async () =>
      createHandle(
        '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"pong"}}\n'
      )
    )
    const backend = new AntigravityCliBackend({ spawn })

    const run = await backend.runTurn({
      prompt: 'User: ping',
      conversationId: 'conversation-1',
      writeGrant: TEST_GRANT,
      windowId: 'window-1',
      options: { backend: 'antigravity_cli', model: 'gemini-3.1-pro-high' }
    })

    const events: BackendEvent[] = []
    for await (const event of run.events) events.push(event)

    expect(spawn).toHaveBeenCalledWith({
      prompt: 'User: ping',
      writeGrant: TEST_GRANT,
      windowId: 'window-1',
      model: 'gemini-3.1-pro-high',
      purpose: 'turn'
    })
    expect(events).toEqual([{ kind: 'assistant_delta', text: 'pong' }])
  })

  it('ignores a model chosen for a different backend', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new AntigravityCliBackend({ spawn })

    await backend.runTurn({
      prompt: 'User: ping',
      conversationId: 'conversation-1',
      writeGrant: TEST_GRANT,
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'high', model: 'gpt-5.5' }
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }))
  })

  it('marks title and summary runs with tool-free purposes', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new AntigravityCliBackend({ spawn })

    await backend.generateTitle({
      prompt: 'Title this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'antigravity_cli' }
    })
    await backend.summarize({
      prompt: 'Summarize this conversation',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'antigravity_cli' }
    })

    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'title' }))
    expect(spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'summary' }))
  })

  it('forwards turn permissions to the subprocess adapter', async () => {
    const spawn = vi.fn(async () => createHandle(''))
    const backend = new AntigravityCliBackend({ spawn })

    await backend.runTurn({
      prompt: 'User: inspect',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      writeGrant: TEST_GRANT,
      options: { backend: 'antigravity_cli' },
      permissions: { accessMode: 'computer_access', webSearchEnabled: true }
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { accessMode: 'computer_access', webSearchEnabled: true }
      })
    )
  })

  it('reports Antigravity CLI availability through the unified backend status shape', async () => {
    const backend = new AntigravityCliBackend({ spawn: vi.fn() })

    await expect(backend.getStatus()).resolves.toEqual({
      backend: 'antigravity_cli',
      available: true,
      reason: null,
      detail: null,
      version: '1.2.7',
      minimumRequired: '1.2.7'
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
