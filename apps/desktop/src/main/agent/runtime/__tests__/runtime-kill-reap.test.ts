import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: mocks.setWriteGate
}))

import { createEscalatingKill } from '../../cli/kill'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

// A real child that traps SIGTERM, exactly like a CLI with its own signal
// handler. Nothing below AgentRuntime is faked here: real pid, real signals.
const CHILD_SCRIPT = `'use strict'
process.on('SIGTERM', () => {})
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)
`

let fixtureDir: string
let childScript: string
const children: ChildProcess[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-agent-reap-'))
  childScript = path.join(fixtureDir, 'child.cjs')
  await writeFile(childScript, CHILD_SCRIPT)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  // Runs even when the test body throws, so a red run never leaks a child.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

function runtime(): AgentRuntime {
  return new AgentRuntime({
    conversations: {} as ConversationStore,
    messages: {} as MessageStore
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startSigtermIgnoringChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [childScript], { stdio: 'pipe' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
  })
  return child
}

describe('AgentRuntime.killAll reaping', () => {
  it('does not resolve until a SIGTERM-ignoring child is actually gone', async () => {
    const agentRuntime = runtime()
    const child = await startSigtermIgnoringChild()
    const pid = child.pid as number
    // Subscribed eagerly, exactly as bootstrap.ts does: a listener attached
    // after the exit would never fire.
    const exitCodePromise = new Promise<number>((resolve) => {
      child.once('exit', (code) => resolve(code ?? 0))
    })

    agentRuntime.trackSubprocess('conversation-1', {
      pid,
      kill: createEscalatingKill(child),
      waitExit: () => exitCodePromise
    })

    const startedAt = Date.now()
    await agentRuntime.killAll()
    const elapsed = Date.now() - startedAt

    // The OS, not our bookkeeping: the pid no longer exists.
    expect(isAlive(pid)).toBe(false)
    expect(child.signalCode).toBe('SIGKILL')
    // Proves killAll waited for the escalation rather than firing and forgetting.
    expect(elapsed).toBeGreaterThanOrEqual(900)
  })

  it('gives up on a child that will not die after 1200ms, and keeps it reachable', async () => {
    vi.useFakeTimers()
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', {
      pid: 7,
      kill,
      waitExit: () => new Promise<number>(() => {})
    })

    let settled = false
    const shutdown = agentRuntime.killAll().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(1199)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(settled).toBe(true)
    expect(kill).toHaveBeenCalledTimes(1)

    // Still tracked: a child that outlived the budget must remain reachable, not
    // be dropped from the map while it is alive.
    agentRuntime.cancelTurn('conversation-1')
    expect(kill).toHaveBeenCalledTimes(2)
  })

  it('untracks a child once its exit is observed', async () => {
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', {
      pid: 8,
      kill,
      waitExit: async () => 0
    })

    await agentRuntime.killAll()
    expect(kill).toHaveBeenCalledTimes(1)

    agentRuntime.cancelTurn('conversation-1')
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('keeps a child tracked when waiting on its exit rejects', async () => {
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', {
      pid: 9,
      kill,
      waitExit: async () => {
        throw new Error('exit stream gone')
      }
    })

    await agentRuntime.killAll()
    expect(kill).toHaveBeenCalledTimes(1)

    // Exit unknown, so the child is assumed alive and stays reachable.
    agentRuntime.cancelTurn('conversation-1')
    expect(kill).toHaveBeenCalledTimes(2)
  })

  it('reaps nothing and resolves immediately when no subprocess is tracked', async () => {
    const agentRuntime = runtime()
    await expect(agentRuntime.killAll()).resolves.toBeUndefined()
    expect(mocks.setWriteGate).toHaveBeenLastCalledWith(null)
  })
})
