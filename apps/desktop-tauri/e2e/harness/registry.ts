import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { purgeKeychainForDevice } from './keychain-cleanup.mjs'

// The wdio launcher purges in `onComplete`, but the apps are created in worker processes, so
// the devices travel through a ledger file keyed by the run id the launcher exported.
const ROOT = join(tmpdir(), 'memry-e2e')

function ledgerPath(): string | undefined {
  const runId = process.env.MEMRY_E2E_RUN_ID
  return runId ? join(ROOT, `devices-${runId}.txt`) : undefined
}

/** The launcher calls this once, before it spawns workers. */
export function startRun(): string {
  const runId = `${process.pid}-${Date.now()}`
  process.env.MEMRY_E2E_RUN_ID = runId
  return runId
}

export function recordDevice(device: string): void {
  const path = ledgerPath()
  if (!path) return
  mkdirSync(ROOT, { recursive: true })
  appendFileSync(path, `${device}\n`)
}

/** Purges the keychain items of every device a worker of this run created. */
export function purgeAllCreatedDevices(): void {
  const path = ledgerPath()
  if (!path || !existsSync(path)) return
  const devices = new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean))
  for (const device of devices) purgeKeychainForDevice(device)
  rmSync(path, { force: true })
}
