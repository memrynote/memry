import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/fake-dir'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

import { spawnClaudeTurn } from '../spawn'

describe('spawnClaudeTurn', () => {
  it('writes mcp-config.json with bearer + conversation/window headers', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      authorizationValue: 'test-auth-value',
      conversationId: 'conv-1',
      windowId: 'win-1',
      allowedTools: 'mcp__memry__vault_read_note',
      prompt: 'hello'
    })

    expect(writeFile).toHaveBeenCalled()
    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string)
    expect(written.mcpServers.memry.url).toBe('http://127.0.0.1:54321/mcp')
    expect(written.mcpServers.memry.headers.Authorization).toBe('Bearer test-auth-value')
    expect(written.mcpServers.memry.headers['X-Memry-Conversation']).toBe('conv-1')
    expect(written.mcpServers.memry.headers['X-Memry-Window']).toBe('win-1')
  })

  it('passes the spec-mandated CLI flags', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      authorizationValue: 'test-auth-value',
      conversationId: 'c',
      windowId: 'w',
      allowedTools: 'mcp__memry__vault_read_note',
      prompt: 'p'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('-p')
    expect(args).toContain('--input-format')
    expect(args).toContain('text')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--verbose')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--tools')
    expect(args).toContain('')
    expect(args).toContain('--allowed-tools')
    expect(args).toContain('mcp__memry__vault_read_note')
    expect(args).toContain('--mcp-config')
  })

  it('writes the prompt to stdin and closes it', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      authorizationValue: 'test-auth-value',
      conversationId: 'c',
      windowId: 'w',
      allowedTools: 'a',
      prompt: 'PROMPT BODY'
    })

    expect(fakeProc.stdin.write).toHaveBeenCalledWith('PROMPT BODY')
    expect(fakeProc.stdin.end).toHaveBeenCalled()
  })
})

function makeFakeProc() {
  return {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 1234
  } as any
}
