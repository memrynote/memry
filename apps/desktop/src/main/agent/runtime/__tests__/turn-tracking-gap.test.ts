import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

import type { AgentBackend, BackendRunHandle } from '../../backends/types'
import type { AgentBackendRegistry } from '../../backends/registry'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type { Message } from '../../storage/types'
import { runTurn } from '../turn'

// Nothing below the backend is faked: `runTurn` drives a real `node` child over
// a real pipe. The child writes nothing to stdout and holds its own event loop
// open, so it cannot exit on its own and the parent dropping the read end of
// stdout cannot end it either. Only a signal ends it — which is what makes a
// survivor here a genuine orphan rather than a child that was about to die.
//
// The ready file closes the boot race: a signal delivered before the child's JS
// runs hits the default disposition, so tests that need a booted child (one that
// has installed its own SIGTERM handler) must wait for this marker first.
const CHILD_SCRIPT = `'use strict'
const fs = require('node:fs')
if (process.env.MEMRY_TEST_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
fs.writeFileSync(process.env.MEMRY_TEST_READY_FILE, 'ready')
const lingerMs = Number(process.env.MEMRY_TEST_LINGER_MS || '0')
if (lingerMs > 0) setTimeout(() => {}, lingerMs)
`

// Long enough that a surviving child is unambiguously an orphan and not a race,
// short enough that a leaked one cannot outlive the suite by much.
const LINGER_MS = 60000

// Every fixture lives inside a per-run mkdtemp directory, so no test writes to a
// predictable path in the OS temp dir.
let fixtureDir: string
let childScript: string
let childCount = 0
const children: ChildProcess[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-turn-tracking-gap-'))
  childScript = path.join(fixtureDir, 'child.cjs')
  await writeFile(childScript, CHILD_SCRIPT)
})

afterEach(() => {
  // Runs even when the test body throws, so a red run never leaks a 60s child.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

// The only honest liveness check: ask the OS about the pid. `kill(pid, 0)`
// throws ESRCH once the child is gone and reaped, which is exactly the state a
// resolved `waitExit()` guarantees.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function describeChild(pid: number, tracked: Map<number, unknown>): string {
  if (!isAlive(pid)) return 'gone'
  return tracked.has(pid) ? 'alive-and-tracked' : 'alive-and-untracked-orphan'
}

interface StartedChild {
  pid: number
  handle: BackendRunHandle
}

async function startChild(
  opts: { lingerMs?: number; ignoreSigterm?: boolean; overrides?: Partial<BackendRunHandle> } = {}
): Promise<StartedChild> {
  const readyFile = path.join(fixtureDir, `ready-${(childCount += 1)}`)
  const child = spawn(process.execPath, [childScript], {
    env: {
      ...process.env,
      MEMRY_TEST_READY_FILE: readyFile,
      MEMRY_TEST_LINGER_MS: String(opts.lingerMs ?? 0),
      ...(opts.ignoreSigterm ? { MEMRY_TEST_IGNORE_SIGTERM: '1' } : {})
    }
  })
  children.push(child)

  const pid = child.pid
  if (pid === undefined) throw new Error('child failed to spawn')
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) throw new Error('child pipes missing')

  await waitForReady(readyFile)

  const handle: BackendRunHandle = {
    events: (async function* () {
      for await (const chunk of stdout) void chunk
    })(),
    stderr,
    pid,
    kill: () => {
      child.kill()
    },
    waitExit: () =>
      new Promise<number>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode ?? 0)
          return
        }
        child.once('exit', (code) => resolve(code ?? 0))
      }),
    cleanup: async () => {},
    ...opts.overrides
  }

  return { pid, handle }
}

async function waitForReady(readyFile: string): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      await access(readyFile)
      return
    } catch {
      if (Date.now() > deadline) throw new Error('child never reported readiness')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

// Mirrors apps/desktop/src/main/ipc/agent-handlers.ts: the pid goes into the map
// that killAll() walks at quit, and the wrapper's cleanup() is the only thing
// that ever takes it back out.
function createTrackingRegistry(): {
  tracked: Map<number, { pid: number; kill: () => void }>
  trackRunHandle: (conversationId: string, handle: BackendRunHandle) => BackendRunHandle
} {
  const tracked = new Map<number, { pid: number; kill: () => void }>()
  return {
    tracked,
    trackRunHandle: (_conversationId, handle) => {
      tracked.set(handle.pid, { pid: handle.pid, kill: handle.kill })
      return {
        ...handle,
        cleanup: async () => {
          try {
            await handle.cleanup()
          } finally {
            tracked.delete(handle.pid)
          }
        }
      }
    }
  }
}

const APPEND_FAILURE = 'agent_messages insert failed'

// Stands in for the real store's synchronous libsodium encrypt + better-sqlite3
// INSERT. With `failOn: 'assistant'` the user row lands and the assistant
// placeholder throws, which is the append that sits inside the tracking gap.
function createMessageStore(opts: { failOn?: Message['role'] } = {}): MessageStore {
  let nextId = 0
  const stored: Message[] = []
  return {
    append: (input: Parameters<MessageStore['append']>[0]): Message => {
      if (input.role === opts.failOn) throw new Error(APPEND_FAILURE)
      const message: Message = {
        id: `message-${(nextId += 1)}`,
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
      stored.push(message)
      return message
    },
    getById: (id: string) => stored.find((message) => message.id === id) ?? null,
    listByConversation: () => [...stored],
    updateStreaming: vi.fn(),
    markTerminal: (id: string, status: Message['status']) => {
      const message = stored.find((entry) => entry.id === id)
      if (!message) throw new Error(`Message ${id} not found`)
      message.status = status
      return message
    }
  } as unknown as MessageStore
}

function createConversationStore(): ConversationStore {
  const conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    // Not the default title, so the turn never spawns a second child to title it.
    title: 'Existing conversation',
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
  }
  return {
    create: vi.fn(),
    getById: vi.fn(() => conversation),
    listByVault: vi.fn(() => [conversation]),
    update: vi.fn(),
    softDelete: vi.fn(),
    addToTrustList: vi.fn(),
    removeFromTrustList: vi.fn()
  } as unknown as ConversationStore
}

function createRegistry(handle: BackendRunHandle): AgentBackendRegistry {
  const backend: AgentBackend = {
    id: 'claude_cli',
    runTurn: vi.fn(async () => handle),
    generateTitle: vi.fn(async () => handle),
    summarize: vi.fn(async () => handle),
    cancel: vi.fn(),
    getStatus: vi.fn(async () => ({ backend: 'claude_cli' as const, available: true }))
  }
  return { get: vi.fn(() => backend), list: vi.fn(() => [backend]) }
}

function invokeTurn(
  handle: BackendRunHandle,
  trackRunHandle: (conversationId: string, handle: BackendRunHandle) => BackendRunHandle,
  messages: MessageStore
): Promise<{ turnId: string }> {
  return runTurn(
    {
      conversations: createConversationStore(),
      messages,
      backends: createRegistry(handle),
      trackRunHandle
    },
    {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
    }
  )
}

describe('runTurn subprocess lifetime between tracking and the turn loop', () => {
  it('kills and untracks the child when the assistant append throws in that gap', async () => {
    const { pid, handle } = await startChild({ lingerMs: LINGER_MS })
    const { tracked, trackRunHandle } = createTrackingRegistry()

    await expect(
      invokeTurn(handle, trackRunHandle, createMessageStore({ failOn: 'assistant' }))
    ).rejects.toThrow(APPEND_FAILURE)

    expect(describeChild(pid, tracked)).toBe('gone')
    expect(tracked.has(pid)).toBe(false)
  })

  it('keeps a child that ignores the kill tracked, so killAll still reaches it', async () => {
    const { pid, handle } = await startChild({ lingerMs: LINGER_MS, ignoreSigterm: true })
    const { tracked, trackRunHandle } = createTrackingRegistry()

    await expect(
      invokeTurn(handle, trackRunHandle, createMessageStore({ failOn: 'assistant' }))
    ).rejects.toThrow(APPEND_FAILURE)

    expect(describeChild(pid, tracked)).toBe('alive-and-tracked')
    expect(tracked.get(pid)?.pid).toBe(pid)
  }, 20000)

  it('keeps the child tracked when kill() itself throws', async () => {
    const { pid, handle } = await startChild({
      lingerMs: LINGER_MS,
      overrides: {
        kill: () => {
          throw new Error('kill failed')
        }
      }
    })
    const { tracked, trackRunHandle } = createTrackingRegistry()

    await expect(
      invokeTurn(handle, trackRunHandle, createMessageStore({ failOn: 'assistant' }))
    ).rejects.toThrow(APPEND_FAILURE)

    expect(describeChild(pid, tracked)).toBe('alive-and-tracked')
  })

  it('keeps the child tracked when waitExit rejects instead of reporting the exit', async () => {
    const { pid, handle } = await startChild({
      lingerMs: LINGER_MS,
      overrides: {
        kill: () => {},
        waitExit: () => Promise.reject(new Error('waitExit failed'))
      }
    })
    const { tracked, trackRunHandle } = createTrackingRegistry()

    await expect(
      invokeTurn(handle, trackRunHandle, createMessageStore({ failOn: 'assistant' }))
    ).rejects.toThrow(APPEND_FAILURE)

    expect(describeChild(pid, tracked)).toBe('alive-and-tracked')
  })

  it('leaves a turn whose gap succeeds to finish and untrack on its own', async () => {
    const { pid, handle } = await startChild()
    const { tracked, trackRunHandle } = createTrackingRegistry()

    await expect(invokeTurn(handle, trackRunHandle, createMessageStore())).resolves.toEqual({
      turnId: expect.any(String)
    })

    expect(describeChild(pid, tracked)).toBe('gone')
    expect(tracked.has(pid)).toBe(false)
  })
})
