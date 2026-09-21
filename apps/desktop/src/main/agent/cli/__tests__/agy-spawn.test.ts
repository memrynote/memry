import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/memry-agy-test'),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../agy-config', () => ({
  ensureAgyConfig: vi.fn(async (input: { permissions: { accessMode: string } }) => ({
    projectId:
      input.permissions.accessMode === 'computer_access'
        ? 'memry-agent-computer'
        : 'memry-agent-vault',
    serverName: 'memry'
  }))
}))

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { rm } from 'node:fs/promises'

import { ensureAgyConfig } from '../agy-config'
import { agyBridgeRuntime, spawnAgyTurn } from '../agy-spawn'

const BRIDGE = { command: '/Apps/MemryNote', scriptPath: '/Apps/out/main/agy-mcp-bridge.js' }

describe('spawnAgyTurn', () => {
  it('streams the prompt over stdin and carries turn secrets in the environment', async () => {
    const fakeProc = mockSpawnedProc()

    await spawnAgyTurn({
      binaryPath: 'agy',
      prompt: 'User: /notes please',
      bridge: BRIDGE,
      mcp: {
        serverUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'test-token',
        writeGrant: 'turn-grant-1',
        windowId: 'window-1'
      }
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--project',
      'memry-agent-vault'
    ])

    const options = vi.mocked(spawn).mock.calls[0][2] as {
      cwd: string
      stdio: string[]
      env: NodeJS.ProcessEnv
    }
    expect(options.cwd).toBe('/tmp/memry-agy-test')
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    // agy reads MCP servers from a static file that does not expand env
    // references, so the stdio bridge it launches inherits these instead.
    expect(options.env.MEMRY_MCP_URL).toBe('http://127.0.0.1:54321/mcp')
    expect(options.env.MEMRY_AGENT_TOKEN).toBe('test-token')
    expect(options.env.MEMRY_AGENT_TURN).toBe('turn-grant-1')
    expect(options.env.MEMRY_AGENT_WINDOW).toBe('window-1')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')

    // The prompt never becomes an argv entry: a turn carries whole notes.
    expect(args).not.toContain('User: /notes please')
    expect(fakeProc.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: 'user', message: { content: 'User: /notes please' } })}\n`
    )
    expect(fakeProc.stdin.end).toHaveBeenCalled()
  })

  it('opens the sandbox only when computer access is requested', async () => {
    mockSpawnedProc()

    await spawnAgyTurn({
      binaryPath: 'agy',
      prompt: 'inspect files',
      bridge: BRIDGE,
      permissions: { accessMode: 'computer_access', webSearchEnabled: false }
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/')
    expect(args[args.indexOf('--project') + 1]).toBe('memry-agent-computer')
  })

  it('defaults to vault-only permissions when the caller passes none', async () => {
    mockSpawnedProc()

    await spawnAgyTurn({ binaryPath: 'agy', prompt: 'hello', bridge: BRIDGE })

    expect(vi.mocked(ensureAgyConfig).mock.lastCall?.[0].permissions).toEqual({
      accessMode: 'vault_only',
      webSearchEnabled: false
    })
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('passes an explicit model when selected', async () => {
    mockSpawnedProc()

    await spawnAgyTurn({
      binaryPath: 'agy',
      prompt: 'hello',
      bridge: BRIDGE,
      model: 'gemini-3.1-pro-high'
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-pro-high')
  })

  it('cleans up its working directory when the caller is done', async () => {
    mockSpawnedProc()

    const sub = await spawnAgyTurn({ binaryPath: 'agy', prompt: 'hello', bridge: BRIDGE })
    await sub.cleanup()

    expect(vi.mocked(rm)).toHaveBeenCalledWith('/tmp/memry-agy-test', {
      recursive: true,
      force: true
    })
  })

  it('survives a stdin error from a CLI that exits before reading the prompt', async () => {
    const fakeProc = mockSpawnedProc()

    const sub = await spawnAgyTurn({ binaryPath: 'agy', prompt: 'hello', bridge: BRIDGE })
    // EPIPE arrives on stdin, not on the child; unhandled it is a main-process
    // uncaughtException.
    expect(() =>
      fakeProc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).not.toThrow()
    expect(sub.pid).toBe(4321)
  })

  it("runs the bridge as node through the app's own binary", () => {
    const runtime = agyBridgeRuntime()

    expect(runtime.command).toBe(process.execPath)
    expect(runtime.scriptPath).toMatch(/agy-mcp-bridge\.js$/)
  })

  it('omits the turn environment for title and summary prompts', async () => {
    mockSpawnedProc()

    await spawnAgyTurn({ binaryPath: 'agy', prompt: 'Title this', bridge: BRIDGE })

    const options = vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    expect(options.env.MEMRY_AGENT_TOKEN).toBeUndefined()
    expect(options.env.MEMRY_AGENT_TURN).toBeUndefined()
    expect(options.env.MEMRY_MCP_URL).toBeUndefined()
  })
})

type FakeProc = ChildProcessWithoutNullStreams & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
}

function mockSpawnedProc(): FakeProc {
  // spawnAgyTurn waits for the child's 'spawn' event before returning, so the
  // fake has to be a real emitter that reports a successful start.
  const proc = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    pid: 4321
  }) as unknown as FakeProc
  vi.mocked(spawn).mockReturnValue(proc)
  setImmediate(() => proc.emit('spawn'))
  return proc
}
