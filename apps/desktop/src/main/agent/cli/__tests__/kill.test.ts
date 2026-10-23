import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createEscalatingKill, type EscalatableChild } from '../kill'

// A real child, not a mock: the whole point of the issue is what the OS does
// with a process that installs a SIGTERM handler and then declines to die.
const CHILD_SCRIPT = `'use strict'
if (process.env.MEMRY_TEST_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
process.stdout.write('ready\\n')
// Holds the event loop open forever; only a signal can end this process.
setInterval(() => {}, 1000)
`

// What #1179 gives an abandoned child before it stops waiting. Escalation has to
// finish inside that, so this doubles as the upper-bound pin on the delay.
const ABANDONED_KILL_GRACE_MS = 2000

// Every fixture lives inside a per-run mkdtemp directory, never a predictable
// path in the OS temp dir.
let fixtureDir: string
let childScript: string
const children: ChildProcess[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-agent-kill-'))
  childScript = path.join(fixtureDir, 'child.cjs')
  await writeFile(childScript, CHILD_SCRIPT)
})

afterEach(() => {
  vi.useRealTimers()
  // Runs even when the test body throws, so a red run never leaks a child that
  // would otherwise sit in setInterval forever.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

async function startChild(options: { ignoreSigterm: boolean }): Promise<ChildProcess> {
  const child = spawn(process.execPath, [childScript], {
    stdio: 'pipe',
    env: { ...process.env, MEMRY_TEST_IGNORE_SIGTERM: options.ignoreSigterm ? '1' : '0' }
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
  })
  return child
}

// The only honest liveness check: ask the OS about the pid. `kill(pid, 0)`
// throws ESRCH once the process is gone and reaped.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child: ChildProcess, budgetMs: number): Promise<'exited' | 'timed-out'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), budgetMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve('exited')
    })
  })
}

function stubChild(overrides: Partial<EscalatableChild> = {}): EscalatableChild & {
  kill: ReturnType<typeof vi.fn>
} {
  const kill = vi.fn(() => true)
  return {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill,
    once: () => undefined,
    ...overrides
  } as EscalatableChild & { kill: ReturnType<typeof vi.fn> }
}

describe('createEscalatingKill', () => {
  it('escalates to SIGKILL so a SIGTERM-ignoring CLI is gone (ESRCH) within the abandoned-child grace', async () => {
    const child = await startChild({ ignoreSigterm: true })
    const pid = child.pid as number

    createEscalatingKill(child)()

    // SIGTERM has already been delivered and deliberately ignored: this is the
    // live orphan the issue describes, still running with our signal absorbed.
    expect(isAlive(pid)).toBe(true)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()

    expect(await waitForExit(child, ABANDONED_KILL_GRACE_MS)).toBe('exited')
    expect(child.signalCode).toBe('SIGKILL')
    expect(isAlive(pid)).toBe(false)
  })

  it('lets a CLI that handles SIGTERM exit on its own and never escalates', async () => {
    const child = await startChild({ ignoreSigterm: false })
    const pid = child.pid as number
    const killSpy = vi.spyOn(child, 'kill')

    createEscalatingKill(child)()

    expect(await waitForExit(child, ABANDONED_KILL_GRACE_MS)).toBe('exited')
    expect(child.signalCode).toBe('SIGTERM')
    expect(isAlive(pid)).toBe(false)

    // Well past the escalation deadline: the armed timer must have been
    // disarmed by the child's own exit, not left to fire at a recycled pid.
    await new Promise((resolve) => setTimeout(resolve, ABANDONED_KILL_GRACE_MS))
    expect(killSpy.mock.calls).toEqual([['SIGTERM']])
  })

  it('sends SIGKILL at 900ms and not a millisecond earlier', () => {
    vi.useFakeTimers()
    const child = stubChild()

    createEscalatingKill(child)()
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])

    // Too short a delay would rob a well-behaved CLI of its flush window.
    vi.advanceTimersByTime(899)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])

    // Too long a delay would push escalation outside the shutdown budget.
    vi.advanceTimersByTime(1)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('does not stack a second escalation when cancel is followed by quit', () => {
    vi.useFakeTimers()
    const child = stubChild()
    const kill = createEscalatingKill(child)

    kill()
    kill()
    vi.advanceTimersByTime(900)

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGKILL']])
  })

  it('signals nothing once the child has already exited', () => {
    vi.useFakeTimers()
    const exited = stubChild({ exitCode: 0 })
    const signalled = stubChild({ signalCode: 'SIGTERM' })

    createEscalatingKill(exited)()
    createEscalatingKill(signalled)()
    vi.advanceTimersByTime(900)

    expect(exited.kill).not.toHaveBeenCalled()
    expect(signalled.kill).not.toHaveBeenCalled()
  })

  it('still escalates when the SIGTERM itself throws', () => {
    vi.useFakeTimers()
    const child = stubChild({
      kill: vi.fn((signal?: number | NodeJS.Signals) => {
        if (signal === 'SIGTERM') throw new Error('EPERM')
        return true
      }) as unknown as EscalatableChild['kill']
    })

    // The throw still propagates to the caller's own catch, but the escalation
    // was armed first, so the child is not left unreachable.
    expect(() => createEscalatingKill(child)()).toThrow('EPERM')
    vi.advanceTimersByTime(900)

    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('swallows a throw from the escalated SIGKILL instead of raising inside the timer', () => {
    vi.useFakeTimers()
    const child = stubChild({
      kill: vi.fn((signal?: number | NodeJS.Signals) => {
        if (signal === 'SIGKILL') throw new Error('EPERM')
        return true
      }) as unknown as EscalatableChild['kill']
    })

    createEscalatingKill(child)()
    expect(() => vi.advanceTimersByTime(900)).not.toThrow()

    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('disarms the escalation when the child exits before the deadline', () => {
    vi.useFakeTimers()
    let onExit: (() => void) | undefined
    const child = stubChild({
      once: (_event: 'exit', listener: () => void) => {
        onExit = listener
        return undefined
      }
    })

    createEscalatingKill(child)()
    onExit?.()
    vi.advanceTimersByTime(900)

    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  })
})
