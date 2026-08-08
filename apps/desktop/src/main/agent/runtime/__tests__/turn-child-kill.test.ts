import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { broadcastAgentEventMock } = vi.hoisted(() => ({ broadcastAgentEventMock: vi.fn() }))
vi.mock('../event-bus', () => ({
  broadcastAgentEvent: broadcastAgentEventMock
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

import { ClaudeCliBackend } from '../../backends/claude-cli-backend'
import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, BackendRunHandle, RawSubprocessHandle } from '../../backends/types'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type { Conversation, Message, MessageContent, MessageRole } from '../../storage/types'
import { runTurn } from '../turn'

// Nothing below the backend is faked: a real `node` child writes real bytes to a
// real pipe. The child never writes again after its first line, so destroying
// the parent's read end of stdout — which is all an abandoned `for await` does —
// cannot make it exit. Only an actual signal can. That is what makes an unkilled
// child here a genuine orphan rather than a child that was about to die anyway.
const CHILD_SCRIPT = `'use strict'
const first = process.env.MEMRY_TEST_FIRST_LINE
const second = process.env.MEMRY_TEST_SECOND_LINE
const delayMs = Number(process.env.MEMRY_TEST_DELAY_MS || '0')
const lingerMs = Number(process.env.MEMRY_TEST_LINGER_MS || '0')
if (process.env.MEMRY_TEST_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
if (first) process.stdout.write(first + '\\n')
setTimeout(() => {
  if (second) process.stdout.write(second + '\\n')
  // Holds the event loop open while writing nothing at all.
  if (lingerMs > 0) setTimeout(() => {}, lingerMs)
}, delayMs)
`

// Long enough that a surviving child is unambiguously an orphan and not a race,
// short enough that a leaked one cannot outlive the suite by much.
const LINGER_MS = 60000

const deltaLine = (text: string): string =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
  })

const STOP_LINE = JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } })

// Every fixture lives inside a per-run mkdtemp directory, so no test writes to a
// predictable path in the OS temp dir.
let fixtureDir: string
let childScript: string
const children: ChildProcess[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-turn-child-kill-'))
  childScript = path.join(fixtureDir, 'child.cjs')
  await writeFile(childScript, CHILD_SCRIPT)
})

afterEach(() => {
  broadcastAgentEventMock.mockReset()
  // Runs even when the test body throws, so a red run never leaks a 60s child.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

// The only honest liveness check: ask the OS about the pid. `kill(pid, 0)`
// throws ESRCH once the child is gone and reaped, which is exactly the state
// `waitExit()` resolving guarantees.
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

describe('runTurn subprocess lifetime on the turn error path', () => {
  it('kills the child before cleanup untracks it, so no orphan survives a mid-turn throw', async () => {
    const child = startChild({ first: deltaLine('hello'), linger: LINGER_MS })
    const backend = createClaudeBackend(child.handle)
    const tracking = createTrackingHarness(child)

    // The issue's stated trigger: an exception raised while handling a turn
    // event. A destroyed window makes the real IPC send throw here.
    broadcastAgentEventMock.mockImplementation((event: { kind: string }) => {
      if (event.kind === 'assistant_text_delta') {
        throw new Error('Object has been destroyed')
      }
    })

    await expect(
      runTurn(
        {
          conversations: createFakeConversationStore({ title: 'Existing conversation' }),
          messages: createFakeMessageStore(),
          backends: createFakeRegistry(backend),
          trackRunHandle: tracking.trackRunHandle
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'hi',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
    ).rejects.toThrow('Object has been destroyed')

    // Both halves of the bug in one readable value: before the fix this is
    // 'alive-and-untracked-orphan' — a child still running that cleanup() has
    // already removed from the map killAll() walks at quit.
    expect(describeChild(child.handle.pid, tracking.tracked)).toBe('gone')
    expect(child.proc.signalCode).toBe('SIGTERM')
    // killAll() reaches the child at every point where it still exists: the kill
    // is issued while the pid is tracked, and the untrack only runs once the
    // child is already gone.
    expect(tracking.trackedWhenKilled).toBe(true)
    expect(tracking.aliveWhenCleanupRan).toBe(false)
  })

  it('gives up on a child that ignores the kill instead of hanging the turn', async () => {
    const child = startChild({
      first: deltaLine('hello'),
      linger: LINGER_MS,
      ignoreSigterm: true
    })
    const backend = createClaudeBackend(child.handle)
    const tracking = createTrackingHarness(child)

    broadcastAgentEventMock.mockImplementation((event: { kind: string }) => {
      if (event.kind === 'assistant_text_delta') {
        throw new Error('Object has been destroyed')
      }
    })

    const startedAt = Date.now()
    await expect(
      runTurn(
        {
          conversations: createFakeConversationStore({ title: 'Existing conversation' }),
          messages: createFakeMessageStore(),
          backends: createFakeRegistry(backend),
          trackRunHandle: tracking.trackRunHandle
        },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'hi',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
    ).rejects.toThrow('Object has been destroyed')

    // The wait is bounded, so closeVault() on the quit path still finishes well
    // inside the 5s budget main gives shutdown before it force-exits. Without
    // the bound this never returns and the leak becomes a hang.
    expect(Date.now() - startedAt).toBeLessThan(5000)
    expect(tracking.killCount).toBe(1)
  })

  it('never kills a turn that is merely slow', async () => {
    const child = startChild({
      first: deltaLine('thinking'),
      second: STOP_LINE,
      // Longer than any plausible "is it stuck?" heuristic would tolerate, and
      // the child produces nothing at all while it waits.
      delay: 400
    })
    const backend = createClaudeBackend(child.handle)
    const tracking = createTrackingHarness(child)
    const messages = createFakeMessageStore()

    await runTurn(
      {
        conversations: createFakeConversationStore({ title: 'Existing conversation' }),
        messages,
        backends: createFakeRegistry(backend),
        trackRunHandle: tracking.trackRunHandle
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    expect(tracking.killCount).toBe(0)
    expect(child.proc.signalCode).toBeNull()
    expect(child.proc.exitCode).toBe(0)
    const all = messages.listByConversation('conversation-1')
    expect(all[1].status).toBe('completed')
    expect(all[1].content).toEqual({ role: 'assistant', data: { text: 'thinking' } })
  })
})

interface StartedChild {
  handle: RawSubprocessHandle
  proc: ChildProcess
  killCount: number
  onKill: () => void
}

function startChild(input: {
  first: string
  second?: string
  delay?: number
  linger?: number
  ignoreSigterm?: boolean
}): StartedChild {
  const proc = spawn(process.execPath, [childScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MEMRY_TEST_FIRST_LINE: input.first,
      ...(input.second ? { MEMRY_TEST_SECOND_LINE: input.second } : {}),
      MEMRY_TEST_DELAY_MS: String(input.delay ?? 0),
      MEMRY_TEST_LINGER_MS: String(input.linger ?? 0),
      ...(input.ignoreSigterm ? { MEMRY_TEST_IGNORE_SIGTERM: '1' } : {})
    }
  })
  children.push(proc)

  const stdout = proc.stdout
  const stderr = proc.stderr
  if (!stdout || !stderr) throw new Error('test child stdio unavailable')

  // Created eagerly and reused, exactly like the production adapter in
  // bootstrap.ts, so waitExit() still resolves when it is called after exit.
  const exitCodePromise = new Promise<number>((resolve) => {
    proc.once('exit', (code) => resolve(code ?? 0))
  })

  const started: StartedChild = {
    proc,
    killCount: 0,
    onKill: () => {},
    handle: {
      stdout,
      stderr,
      pid: proc.pid ?? -1,
      kill: () => {
        started.killCount += 1
        started.onKill()
        proc.kill('SIGTERM')
      },
      waitExit: () => exitCodePromise,
      cleanup: async () => {}
    }
  }
  return started
}

interface TrackingHarness {
  trackRunHandle: (conversationId: string, handle: BackendRunHandle) => BackendRunHandle
  tracked: Map<number, { kill: () => void }>
  trackedWhenKilled: boolean
  aliveWhenCleanupRan: boolean | null
  killCount: number
}

// Mirrors the wrapper agent-handlers.ts installs around every run handle: track
// on creation, untrack inside cleanup(). Untracking is what removes the pid from
// the map killAll() iterates, so the observations below are the real question —
// was the child already dead by the time it stopped being reachable?
function createTrackingHarness(child: StartedChild): TrackingHarness {
  const tracked = new Map<number, { kill: () => void }>()
  const harness: TrackingHarness = {
    tracked,
    trackedWhenKilled: false,
    aliveWhenCleanupRan: null,
    get killCount() {
      return child.killCount
    },
    trackRunHandle: (_conversationId, handle) => {
      tracked.set(handle.pid, { kill: handle.kill })
      return {
        ...handle,
        cleanup: async () => {
          harness.aliveWhenCleanupRan = isAlive(handle.pid)
          try {
            await handle.cleanup()
          } finally {
            tracked.delete(handle.pid)
          }
        }
      }
    }
  }
  child.onKill = () => {
    harness.trackedWhenKilled = tracked.has(child.handle.pid)
  }
  return harness
}

function createClaudeBackend(handle: RawSubprocessHandle): AgentBackend {
  return new ClaudeCliBackend({ spawn: async () => handle })
}

function createFakeRegistry(backend: AgentBackend): AgentBackendRegistry {
  return {
    get: () => backend,
    list: () => [backend]
  }
}

function createFakeConversationStore(overrides: Partial<Conversation> = {}): ConversationStore {
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
    lastSyncedAt: null,
    ...overrides
  }

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

function createFakeMessageStore(): MessageStore {
  const messages: Message[] = []
  let nextId = 1

  const makeMessage = (input: {
    conversationId: string
    role: MessageRole
    content: MessageContent
    status: Message['status']
    attachments: Message['attachments']
    toolCallId?: string | null
  }): Message => ({
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
  })

  return {
    append(input) {
      const message = makeMessage(input)
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
