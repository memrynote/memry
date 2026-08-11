import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/memry-codex-test'),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { spawnCodexTurn } from '../codex-spawn'

describe('spawnCodexTurn', () => {
  it('passes ephemeral MCP config through CLI overrides and env vars', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: '/opt/homebrew/bin/codex',
      prompt: 'hello',
      reasoningEffort: 'high',
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-token',
        conversationId: 'conversation-1',
        windowId: 'window-1'
      }
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.slice(0, 4)).toEqual(['--ask-for-approval', 'never', '--disable', 'shell_tool'])
    expect(args).toContain('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--sandbox')
    expect(args).toContain('read-only')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('--ignore-user-config')
    expect(args).toContain('--ignore-rules')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('-C')
    expect(args).toContain('/tmp/memry-codex-test')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args).toContain('mcp_servers.memry.url="http://127.0.0.1:54321/mcp"')
    expect(args).toContain('mcp_servers.memry.bearer_token_env_var="MEMRY_AGENT_TOKEN"')
    expect(args).toContain(
      'mcp_servers.memry.env_http_headers={"X-Memry-Conversation"="MEMRY_AGENT_CONVERSATION","X-Memry-Window"="MEMRY_AGENT_WINDOW"}'
    )
    expect(args).toContain('mcp_servers.memry.default_tools_approval_mode="approve"')

    const options = vi.mocked(spawn).mock.calls[0][2] as {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: string[]
    }
    expect(options.cwd).toBe('/tmp/memry-codex-test')
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(options.env.MEMRY_AGENT_TOKEN).toBe('test-token')
    expect(options.env.MEMRY_AGENT_CONVERSATION).toBe('conversation-1')
    expect(options.env.MEMRY_AGENT_WINDOW).toBe('window-1')
  })

  it('passes native web search without opening the filesystem sandbox', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: '/opt/homebrew/bin/codex',
      prompt: 'search for this',
      reasoningEffort: 'medium',
      permissions: { accessMode: 'vault_only', webSearchEnabled: true }
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--search')
    expect(args).toContain('--disable')
    expect(args).toContain('shell_tool')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  it('uses danger-full-access and native tools when computer access is requested', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: '/opt/homebrew/bin/codex',
      prompt: 'inspect files',
      reasoningEffort: 'medium',
      permissions: { accessMode: 'computer_access', webSearchEnabled: false }
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).not.toContain('shell_tool')
    expect(args).not.toContain('apply_patch_freeform')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
  })

  it('passes the prompt as the final exec argument', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: 'codex',
      reasoningEffort: 'medium',
      prompt: 'PROMPT BODY'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.at(-1)).toBe('PROMPT BODY')
    expect(args).not.toContain('--model')
  })

  it('passes an explicit Codex model when selected', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: 'codex',
      reasoningEffort: 'medium',
      model: 'gpt-5.5',
      prompt: 'PROMPT BODY'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.5')
  })

  it('omits MCP config and memrynote env vars for title and summary prompts', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: 'codex',
      reasoningEffort: 'medium',
      prompt: 'Title this'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.some((arg) => arg.startsWith('mcp_servers.memry.'))).toBe(false)

    const options = vi.mocked(spawn).mock.calls[0][2] as {
      env: NodeJS.ProcessEnv
    }
    expect(options.env.MEMRY_AGENT_TOKEN).toBeUndefined()
    expect(options.env.MEMRY_AGENT_CONVERSATION).toBeUndefined()
    expect(options.env.MEMRY_AGENT_WINDOW).toBeUndefined()
  })
})

function makeFakeProc() {
  // spawnCodexTurn now waits for the child's 'spawn' event before returning, so
  // the fake has to be a real emitter that reports a successful start.
  const proc = new EventEmitter() as any
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.pid = 1234
  setImmediate(() => proc.emit('spawn'))
  return proc
}
