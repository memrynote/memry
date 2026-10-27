import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { appInfo } from '../../harness/tauri-lifecycle'
import { pollUntil } from '../../harness/wait'

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

test('a native crash leaves a minidump written by the out-of-process monitor', async ({ app }) => {
  const { appDataDir, pid } = await appInfo(app)
  expect(dumpsIn(appDataDir)).toEqual([])

  // Fire and forget: the process ends before the reply.
  await invokeTest(app, 'e2e_trigger_crash').catch(() => undefined)

  const written = await pollUntil(() => dumpsIn(appDataDir).length > 0 || undefined, {
    timeoutMs: 30_000,
    intervalMs: 200
  })
  expect(written).toBe(true)
  const [name] = dumpsIn(appDataDir)
  expect(statSync(join(appDataDir, 'crash-dumps', name)).size).toBeGreaterThan(1_000)
  expect(await pollUntil(() => !isAlive(pid) || undefined, { timeoutMs: 15_000 })).toBe(true)
})

test('the monitor runs beside the app and ends when the app quits', async ({ app }) => {
  if (process.platform === 'win32') return
  const { pid } = await appInfo(app)
  const started = await pollUntil(() => monitorsOf(pid).length === 1 || undefined, {
    timeoutMs: 15_000
  })
  expect(started).toBe(true)
  const [monitor] = monitorsOf(pid)

  await invokeTest(app, 'e2e_request_quit')
  expect(await pollUntil(() => !isAlive(pid) || undefined, { timeoutMs: 15_000 })).toBe(true)
  expect(await pollUntil(() => !isAlive(monitor) || undefined, { timeoutMs: 15_000 })).toBe(true)
})
