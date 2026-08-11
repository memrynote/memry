import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

// vi.hoisted, not a plain const: the logger module is pulled in eagerly by the
// main-process import graph, so the factory runs before a plain const exists.
const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn()
  })
}))

import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, BackendRunHandle, RawSubprocessHandle } from '../../backends/types'
import { ClaudeCliBackend } from '../../backends/claude-cli-backend'
import type { BackendEvent } from '../../cli/types'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type { Conversation, Message, MessageContent, MessageRole } from '../../storage/types'
import { runTurn } from '../turn'

// Nothing here is mocked below the backend: a real child process writes a real
// megabyte to a real stderr pipe. 1 MB is 16x the 64 KB OS pipe buffer, so the
// child hits backpressure long before it is done and only finishes if the
// parent actually reads. The reply line the turn needs is written to stdout
// *after* the flood, so a parent that never drains stderr never sees stdout,
// never sees the child exit, and hangs forever.
const STDERR_BYTES = 1024 * 1024

// Well under the 30s project testTimeout, so a hang fails as an explicit
// deadline error with the child killed, not as a suite-wide timeout that
// strands a blocked process.
const DEADLINE_MS = 8000

const FLOOD_SCRIPT = `'use strict'
const total = Number(process.env.MEMRY_TEST_STDERR_BYTES)
const reply = process.env.MEMRY_TEST_STDOUT_LINE
const tail = process.env.MEMRY_TEST_STDERR_TAIL || ''
const CHUNK = Buffer.alloc(64 * 1024, 0x61)
let remaining = total
const pump = () => {
  while (remaining > 0) {
    const size = Math.min(CHUNK.length, remaining)
    remaining -= size
    if (!process.stderr.write(CHUNK.subarray(0, size))) {
      process.stderr.once('drain', pump)
      return
    }
  }
  if (tail) process.stderr.write(tail)
  if (reply) process.stdout.write(reply + '\\n')
  // Set, never process.exit(): exiting here would truncate the pipes.
  process.exitCode = Number(process.env.MEMRY_TEST_EXIT_CODE || '0')
}
pump()
`

// Written last, after the megabyte of noise, exactly where a real CLI puts the
// reason it died.
const FATAL_TAIL = 'FATAL: memry mcp handshake refused'

// Every fixture lives inside a per-run mkdtemp directory, so no test ever
// creates a file at a predictable path in the OS temp dir.
let fixtureDir: string
let floodScript: string
const children: ChildProcess[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-turn-stderr-drain-'))
  floodScript = path.join(fixtureDir, 'flood.cjs')
  await writeFile(floodScript, FLOOD_SCRIPT)
})

afterEach(() => {
  loggerWarnMock.mockClear()
  // Runs even when the test body throws, so a red run never leaves a blocked
  // child behind holding the vitest fork open.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

describe('agent turns against a CLI that floods stderr', () => {
  it('completes the title turn and applies the generated title', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const cli = floodingCli('{"type":"result","result":"Weekly Review Plan"}')

    await withDeadline(
      'title turn',
      runTurn(
        {
          conversations,
          messages,
          backends: createFakeRegistry(backendOverFloodingCli(cli.spawn, 'title'))
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'plan my week from my notes',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
    )

    // The generated title, not deterministicTitle('plan my week from my notes')
    // — the fallback a swallowed title failure would have produced.
    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'Weekly Review Plan' },
      ['title']
    )
    // Proof the pipe really was filled and then drained end to end.
    expect(cli.stderrBytesRead()).toBe(STDERR_BYTES)
    expect(cli.child()?.exitCode).toBe(0)
    // No listener or stream left behind on the success path.
    expect(cli.child()?.stderr?.readableEnded).toBe(true)
    expect(cli.child()?.stdout?.readableEnded).toBe(true)
  })

  it('completes the compaction summary turn and records the summary', async () => {
    // Two oversized messages push the assembled prompt past COMPACTION_THRESHOLD;
    // the seeded user message is also what keeps the title path out of this test.
    const messages = createFakeMessageStore([
      seedMessage({
        id: 'old-1',
        role: 'user',
        content: { role: 'user', data: { text: 'a'.repeat(210_000) } },
        createdAt: 1
      }),
      seedMessage({
        id: 'old-2',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'b'.repeat(210_000) } },
        createdAt: 2
      })
    ])
    const conversations = createFakeConversationStore()
    const cli = floodingCli(
      '{"type":"result","result":"Earlier in this conversation: shipped the drain fix"}'
    )

    await withDeadline(
      'compaction summary turn',
      runTurn(
        {
          conversations,
          messages,
          backends: createFakeRegistry(backendOverFloodingCli(cli.spawn, 'summary'))
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'continue',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'high' }
        }
      )
    )

    // A hung or failed summarize is swallowed by runTurn and leaves no marker,
    // so the compacted payload is the only proof the summary actually landed.
    const compacted = messages
      .listByConversation('conversation-1')
      .find((message) => message.role === 'system')
    expect(compacted?.content).toEqual({
      role: 'system',
      data: {
        kind: 'compacted',
        payload: {
          summary: 'Earlier in this conversation: shipped the drain fix',
          summarizedThroughId: 'old-1',
          summarizedAt: expect.any(Number)
        }
      }
    })
    expect(cli.stderrBytesRead()).toBe(STDERR_BYTES)
    expect(cli.child()?.exitCode).toBe(0)
    expect(cli.child()?.stderr?.readableEnded).toBe(true)
    expect(cli.child()?.stdout?.readableEnded).toBe(true)
  })

  it('logs why the summary CLI died and leaves the history uncompacted', async () => {
    const messages = createFakeMessageStore([
      seedMessage({
        id: 'old-1',
        role: 'user',
        content: { role: 'user', data: { text: 'a'.repeat(210_000) } },
        createdAt: 1
      }),
      seedMessage({
        id: 'old-2',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'b'.repeat(210_000) } },
        createdAt: 2
      })
    ])
    const conversations = createFakeConversationStore()
    // No stdout reply and a non-zero exit: the CLI dies after its own noise.
    const cli = floodingCli('', { stderrTail: FATAL_TAIL, exitCode: 1 })

    await withDeadline(
      'failed compaction summary turn',
      runTurn(
        {
          conversations,
          messages,
          backends: createFakeRegistry(backendOverFloodingCli(cli.spawn, 'summary'))
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'continue',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'high' }
        }
      )
    )

    expect(cli.child()?.exitCode).toBe(1)
    expect(cli.stderrBytesRead()).toBe(STDERR_BYTES + FATAL_TAIL.length)
    // The thrown error is swallowed into a compaction warning upstream, so this
    // log line is the only place the CLI's own reason survives.
    const warned = loggerWarnMock.mock.calls.find(
      (call) => call[0] === 'Conversation summary backend exited non-zero'
    )
    expect(warned?.[1]).toEqual({
      backend: 'claude_cli',
      exitCode: 1,
      stderr: expect.stringMatching(new RegExp(`^a{8158}${FATAL_TAIL}$`))
    })
    expect((warned?.[1] as { stderr: string }).stderr).toHaveLength(8192)
    // No 'compacted' marker: a failed summary must never replace the history it
    // failed to summarize. The user's turn runs anyway, uncompacted.
    expect(messages.listByConversation('conversation-1').map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
  })

  it('survives a stderr read error without stranding a rejection in main', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    // A pipe can fail mid-read — the child is killed and its stdio destroyed
    // with an error (stop button, killAll on vault teardown). The CLI here still
    // exits 0, so nothing awaits the drain: unhandled, that rejection reaches
    // main's swallowing uncaughtException handler and vanishes.
    const readError = new Error('read ECONNRESET')
    const unhandled: unknown[] = []
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', recordUnhandled)

    try {
      await withDeadline(
        'title turn over a failing stderr pipe',
        runTurn(
          {
            conversations,
            messages,
            backends: createFakeRegistry(backendWithFailingTitleStderr(readError))
          },
          {
            conversationId: 'conversation-1',
            sourceWindowId: 'window-1',
            text: 'plan my week from my notes',
            attachments: [],
            backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
          }
        )
      )
      // An unhandled rejection is reported a tick after the promise is dropped.
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      process.off('unhandledRejection', recordUnhandled)
    }

    expect(unhandled).toEqual([])
    // The read error is reported, not silently eaten.
    expect(loggerWarnMock).toHaveBeenCalledWith('Failed to read backend stderr', readError)
    // And the turn is unaffected: the title the CLI produced still lands.
    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'Weekly Review Plan' },
      ['title']
    )
  })

  it('keeps the stderr tail for the failure log and discards the noise before it', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    // No stdout reply and a non-zero exit: the CLI dies after its own noise.
    const cli = floodingCli('', { stderrTail: FATAL_TAIL, exitCode: 1 })

    await withDeadline(
      'failed title turn',
      runTurn(
        {
          conversations,
          messages,
          backends: createFakeRegistry(backendOverFloodingCli(cli.spawn, 'title'))
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'plan my week from my notes',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
    )

    expect(cli.child()?.exitCode).toBe(1)
    // Every byte was read — that is what unblocks the child — but only the tail
    // is retained.
    expect(cli.stderrBytesRead()).toBe(STDERR_BYTES + FATAL_TAIL.length)
    const warned = loggerWarnMock.mock.calls.find(
      (call) => call[0] === 'Conversation title backend exited non-zero'
    )
    expect(warned?.[1]).toEqual({
      backend: 'claude_cli',
      exitCode: 1,
      stderr: expect.stringMatching(new RegExp(`^a{8158}${FATAL_TAIL}$`))
    })
    expect((warned?.[1] as { stderr: string }).stderr).toHaveLength(8192)
    // A failed title never costs the user their message: the turn still runs and
    // the conversation falls back to a title derived from what they typed.
    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'plan my week from my notes' },
      ['title']
    )
    expect(messages.listByConversation('conversation-1').map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ])
  })
})

async function withDeadline<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${DEADLINE_MS}ms`)),
      DEADLINE_MS
    )
  })
  try {
    // Promise.race keeps a handler attached to `work`, so a later settlement of
    // the losing promise never surfaces as an unhandled rejection.
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function floodingCli(
  reply: string,
  opts: { stderrTail?: string; exitCode?: number } = {}
): {
  spawn: () => Promise<RawSubprocessHandle>
  stderrBytesRead: () => number
  child: () => ChildProcess | null
} {
  let stderrBytes = 0
  let child: ChildProcess | null = null

  return {
    stderrBytesRead: () => stderrBytes,
    child: () => child,
    // The adapter shape from agent/bootstrap.ts: the raw child pipes, and an
    // exit promise that only ever listens for 'exit'.
    spawn: async () => {
      const proc = spawn(process.execPath, [floodScript], {
        env: {
          ...process.env,
          MEMRY_TEST_STDERR_BYTES: String(STDERR_BYTES),
          MEMRY_TEST_STDOUT_LINE: reply,
          MEMRY_TEST_STDERR_TAIL: opts.stderrTail ?? '',
          MEMRY_TEST_EXIT_CODE: String(opts.exitCode ?? 0)
        }
      })
      children.push(proc)
      child = proc
      const stdout = proc.stdout
      const stderr = proc.stderr
      if (!stdout || !stderr) {
        throw new Error('Claude subprocess stdio unavailable')
      }
      const exitCodePromise = new Promise<number>((resolve) => {
        proc.once('exit', (code) => resolve(code ?? 0))
      })

      return {
        stdout,
        // Pull-based like the raw Readable it wraps: it counts what the consumer
        // actually reads and drains nothing on its own.
        stderr: (async function* () {
          for await (const chunk of stderr) {
            stderrBytes += (chunk as Buffer).length
            yield chunk as Buffer
          }
        })(),
        pid: proc.pid ?? -1,
        kill: () => proc.kill('SIGTERM'),
        waitExit: () => exitCodePromise,
        cleanup: async () => {}
      }
    }
  }
}

function backendOverFloodingCli(
  spawnFn: () => Promise<RawSubprocessHandle>,
  route: 'title' | 'summary'
): AgentBackend {
  // Real ClaudeCliBackend, so the flooding child goes through the real stream
  // parser and the real BackendRunHandle wiring.
  const real = new ClaudeCliBackend({ spawn: spawnFn })
  return {
    id: 'claude_cli',
    // The main turn path already drains stderr, so it stays trivial here; only
    // the path under test gets the flooding CLI.
    runTurn: async () =>
      quickHandle([{ kind: 'assistant_delta', text: 'ok' }, { kind: 'message_stop' }]),
    generateTitle: async (input) => (route === 'title' ? real.generateTitle(input) : quickHandle()),
    summarize: async (input) => (route === 'summary' ? real.summarize(input) : quickHandle()),
    cancel: () => {},
    getStatus: async () => ({ backend: 'claude_cli' as const, available: true })
  }
}

function backendWithFailingTitleStderr(readError: Error): AgentBackend {
  return {
    id: 'claude_cli',
    runTurn: async () =>
      quickHandle([{ kind: 'assistant_delta', text: 'ok' }, { kind: 'message_stop' }]),
    generateTitle: async () => ({
      events: (async function* () {
        yield { kind: 'assistant_delta', text: 'Weekly Review Plan' } as BackendEvent
      })(),
      stderr: (async function* () {
        yield Buffer.from('claude: starting\n')
        throw readError
      })(),
      pid: 2,
      kill: () => {},
      // Exit 0: the failure branch that awaits the drain is never taken, so the
      // rejection has no other observer.
      waitExit: async () => 0,
      cleanup: async () => {}
    }),
    summarize: async () => quickHandle(),
    cancel: () => {},
    getStatus: async () => ({ backend: 'claude_cli' as const, available: true })
  }
}

function quickHandle(events: BackendEvent[] = [{ kind: 'message_stop' }]): BackendRunHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    stderr: (async function* () {})(),
    pid: 1,
    kill: () => {},
    waitExit: async () => 0,
    cleanup: async () => {}
  }
}

function createFakeRegistry(backend: AgentBackend): AgentBackendRegistry {
  return {
    get: vi.fn(() => backend),
    list: vi.fn(() => [backend])
  }
}

function createFakeConversationStore(): ConversationStore {
  const conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'New conversation',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    lastSyncedAt: null
  } as Conversation

  return {
    create: vi.fn(),
    getById: vi.fn(() => conversation),
    listByVault: vi.fn(() => [conversation]),
    update: vi.fn((_id, patch) => ({ ...conversation, ...patch, updatedAt: 2 })),
    softDelete: vi.fn(),
    addToTrustList: vi.fn(),
    removeFromTrustList: vi.fn()
  }
}

function createFakeMessageStore(seed: Message[] = []): MessageStore {
  const messages: Message[] = [...seed]
  let nextId = 1

  return {
    append(input) {
      const message: Message = {
        id: `message-${nextId++}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock: { d: 1 },
        createdAt: nextId,
        updatedAt: nextId,
        deletedAt: null
      }
      messages.push(message)
      return message
    },
    getById(id) {
      return messages.find((message) => message.id === id) ?? null
    },
    listByConversation(conversationId) {
      return messages.filter((message) => message.conversationId === conversationId)
    },
    updateStreaming(id, patch) {
      const message = this.getById(id)
      if (!message) throw new Error(`Message ${id} not found`)
      Object.assign(message, patch, { updatedAt: message.updatedAt + 1 })
      return message
    },
    markTerminal(id, status, patch) {
      const message = this.getById(id)
      if (!message) throw new Error(`Message ${id} not found`)
      Object.assign(message, patch, { status, updatedAt: message.updatedAt + 1 })
      return message
    }
  }
}

function seedMessage(input: {
  id: string
  role: MessageRole
  content: MessageContent
  createdAt: number
}): Message {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role: input.role,
    content: input.content,
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: { d: 1 },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null
  }
}
