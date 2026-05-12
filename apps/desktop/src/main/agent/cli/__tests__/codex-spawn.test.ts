import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/memry-codex-test'),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'

import { spawnCodexTurn } from '../codex-spawn'

describe('spawnCodexTurn', () => {
  it('passes ephemeral MCP config through CLI overrides and env vars', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: '/opt/homebrew/bin/codex',
      mcpServerUrl: 'http://127.0.0.1:54321',
      authorizationValue: 'test-token',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'hello'
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

  it('passes the prompt as the final exec argument', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)

    await spawnCodexTurn({
      binaryPath: 'codex',
      mcpServerUrl: 'http://127.0.0.1:54321',
      authorizationValue: 'token',
      conversationId: 'c',
      windowId: 'w',
      prompt: 'PROMPT BODY'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.at(-1)).toBe('PROMPT BODY')
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
