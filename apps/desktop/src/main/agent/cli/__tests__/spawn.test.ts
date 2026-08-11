import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/fake-dir'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'

import { spawnClaudeTurn } from '../spawn'

describe('spawnClaudeTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes mcp-config.json with bearer + conversation/window headers', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'conv-1',
        windowId: 'win-1',
        allowedTools: 'mcp__memry__vault_read_note'
      },
      effort: 'xhigh',
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
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'c',
        windowId: 'w',
        allowedTools: 'mcp__memry__vault_read_note'
      },
      effort: 'low',
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
    expect(args).toContain('--effort')
    expect(args).toContain('low')
    expect(args).not.toContain('--model')
  })

  it('keeps vault access scoped while enabling web tools when requested', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'c',
        windowId: 'w',
        allowedTools: 'mcp__memry__vault_read_note'
      },
      effort: 'low',
      permissions: { accessMode: 'vault_only', webSearchEnabled: true },
      prompt: 'p'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe(
      'mcp__memry__vault_read_note,WebSearch,WebFetch'
    )
    expect(args).not.toContain('--permission-mode')
  })

  it('enables default Claude tools without allowlisting when computer access is requested', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'c',
        windowId: 'w',
        allowedTools: 'mcp__memry__vault_read_note'
      },
      effort: 'low',
      permissions: { accessMode: 'computer_access', webSearchEnabled: false },
      prompt: 'p'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args[args.indexOf('--tools') + 1]).toBe('default')
    expect(args).toContain('--add-dir')
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/')
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).not.toContain('--allowed-tools')
  })

  it('passes an explicit Claude model when selected', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'c',
        windowId: 'w',
        allowedTools: 'a'
      },
      effort: 'xhigh',
      model: 'opus',
      prompt: 'p'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--model')
    expect(args).toContain('opus')
  })

  it('writes the prompt to stdin and closes it', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-auth-value',
        conversationId: 'c',
        windowId: 'w',
        allowedTools: 'a'
      },
      effort: 'xhigh',
      prompt: 'PROMPT BODY'
    })

    expect(fakeProc.stdin.write).toHaveBeenCalledWith('PROMPT BODY')
    expect(fakeProc.stdin.end).toHaveBeenCalled()
  })

  it('does not write MCP config or pass MCP flags for tool-free runs', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      effort: 'xhigh',
      prompt: 'title only'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(writeFile).not.toHaveBeenCalled()
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--allowed-tools')
  })
})

function makeFakeProc() {
  // spawnClaudeTurn now waits for the child's 'spawn' event before writing the
  // prompt, so the fake has to be a real emitter that reports a successful start.
  const proc = new EventEmitter() as any
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.pid = 1234
  setImmediate(() => proc.emit('spawn'))
  return proc
}
