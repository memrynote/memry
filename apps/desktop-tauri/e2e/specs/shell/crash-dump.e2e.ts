import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { sendTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { appInfo } from '../../harness/tauri-lifecycle'
import { pollUntil, waitForMainLog } from '../../harness/wait'

/** Pids of the crash monitors started by the app `parentPid` (unix only). */
function monitorsOf(parentPid: number): number[] {
  if (process.platform === 'win32') return []
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return table
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => Number(match[2]) === parentPid && match[3].includes('--crash-monitor'))
    .map((match) => Number(match[1]))
}

function dumpsIn(dir: string): string[] {
  const dumps = join(dir, 'crash-dumps')
  if (!existsSync(dumps)) return []
  return readdirSync(dumps).filter((name) => name.endsWith('.dmp'))
}

// The handler attaches on its own thread once the monitor answers; the boot does not wait for it.
// A crash before that leaves no dump, and a quit before that leaves the monitor with no client.
async function handlerAttached(app: { dirs: { logDir: string } }): Promise<void> {
  expect(await waitForMainLog(app, 'crash handler attached')).toBe(true)
}

test('a native crash leaves a minidump written by the out-of-process monitor', async ({ app }) => {
  const { appDataDir, pid } = await appInfo(app)
  expect(dumpsIn(appDataDir)).toEqual([])
  await handlerAttached(app)

  await sendTest(app, 'e2e_trigger_crash')

  const written = await pollUntil(() => dumpsIn(appDataDir).length > 0 || undefined, {
    timeoutMs: 30_000,
    intervalMs: 200
  })
  expect(written).toBe(true)
  const [name] = dumpsIn(appDataDir)
  expect(statSync(join(appDataDir, 'crash-dumps', name)).size).toBeGreaterThan(1_000)
  expect(await pollUntil(() => !isAlive(pid) || undefined, { timeoutMs: 15_000 })).toBe(true)
  // One crash, one dump: a second one keeps the crashed app alive while it is written.
  expect(dumpsIn(appDataDir)).toEqual([name])
})

test('the monitor runs beside the app and ends when the app quits', async ({ app }) => {
  if (process.platform === 'win32') return
  const { pid } = await appInfo(app)
  const started = await pollUntil(() => monitorsOf(pid).length === 1 || undefined, {
    timeoutMs: 15_000
  })
  expect(started).toBe(true)
  const [monitor] = monitorsOf(pid)
  await handlerAttached(app)

  await sendTest(app, 'e2e_request_quit')
  expect(await pollUntil(() => !isAlive(pid) || undefined, { timeoutMs: 15_000 })).toBe(true)
  expect(await pollUntil(() => !isAlive(monitor) || undefined, { timeoutMs: 15_000 })).toBe(true)
})

function procState(pid: number): string {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')
    // stat field 9 (flags) is index 6 after the comm; PF_DUMPCORE = 0x200, PF_EXITING = 0x4.
    const flags = Number(stat?.[6] ?? 0)
    return `${/State:\s*(.*)/.exec(status)?.[1]} flags=0x${flags.toString(16)} dumpcore=${(flags & 0x200) !== 0} exiting=${(flags & 0x4) !== 0}`
  } catch (error) {
    return `gone (${(error as Error).message.slice(0, 40)})`
  }
}

for (let round = 0; round < 6; round++) {
  test(`PROBE #3967 crash exit timing, round ${round}`, async ({ app }) => {
    if (process.platform !== 'linux') return
    const { appDataDir, pid } = await appInfo(app)
    await handlerAttached(app)
    const corePattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim()
    const t0 = Date.now()
    await sendTest(app, 'e2e_trigger_crash')
    await pollUntil(() => dumpsIn(appDataDir).length > 0 || undefined, {
      timeoutMs: 30_000,
      intervalMs: 50
    })
    const tDump = Date.now() - t0
    const samples: string[] = []
    const died = await pollUntil(
      () => {
        if (!isAlive(pid)) return true
        if (samples.length < 40) samples.push(`${Date.now() - t0}ms ${procState(pid)}`)
        return undefined
      },
      { timeoutMs: 40_000, intervalMs: 250 }
    )
    const tDead = Date.now() - t0
    let apport = ''
    try {
      apport = execFileSync('pgrep', ['-c', '-x', 'apport'], { encoding: 'utf8' }).trim()
    } catch {
      apport = '0'
    }
    console.log(
      `PROBE crash round=${round} corePattern=${JSON.stringify(corePattern)} dumpAt=${tDump}ms died=${died} deadAt=${tDead}ms dumps=${dumpsIn(appDataDir).length} apportNow=${apport} samples=${JSON.stringify(samples.filter((_, i) => i % 4 === 0))}`
    )
    expect(died).toBe(true)
  })
}
