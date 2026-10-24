import { type ChildProcess } from 'node:child_process'
import { browser } from '@wdio/globals'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import E2eJunitReporter from './harness/junit-reporter'
import { removeDir } from './harness/remove-dir'
import { binaryPath, driverReady, forceKill, freePort, spawnApp } from './harness/app-process'
import { EXPECT_TIMEOUT_MS, IS_CI, TEST_TIMEOUT_MS } from './harness/budgets'
import { purgeAllCreatedDevices, startRun } from './harness/registry'
import { verifyE2eBinary } from './harness/verify-binary'

// Opens the run-time gate of the e2e build in the launcher and in every worker.
process.env.MEMRY_E2E = '1'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** One app capability. The launcher gives each worker its own port in `onWorkerStart`. */
export function capability(): { browserName: string } {
  return { browserName: 'tauri' }
}

type Target = { port?: number; hostname?: string }

// `@wdio/tauri-service` 1.5.0 starts one app per capability in `onPrepare` and gives parallel
// workers the same port, so every worker would drive one app. The launcher starts one app per
// worker instead (one per multiremote instance) on a free port and points the worker at it. A
// test restarts its app through the harness; this app only exists so the session can open.
const workerApps = new Map<string, { children: ChildProcess[]; ports: number[] }>()

async function startWorkerApps(cid: string, caps: unknown): Promise<void> {
  const targets: Target[] = []
  const record = caps as Record<string, unknown>
  const isMulti = Object.values(record).every(
    (entry) => entry && typeof entry === 'object' && 'capabilities' in entry
  )
  if (Array.isArray(caps)) targets.push(...(caps as Target[]))
  else if (isMulti && Object.keys(record).length > 0)
    targets.push(...(Object.values(record) as Target[]))
  else targets.push(record)

  const started = { children: [] as ChildProcess[], ports: [] as number[] }
  workerApps.set(cid, started)
  for (const target of targets) {
    const port = await freePort()
    started.ports.push(port)
    started.children.push(await spawnApp(port))
    target.port = port
    target.hostname = '127.0.0.1'
  }
}

interface Session {
  options: { port?: number }
  reloadSession(): Promise<string>
}

function sessions(): Session[] {
  const root = browser as unknown as Session & {
    isMultiremote?: boolean
    instances?: string[]
    getInstance(name: string): Session
  }
  return root.isMultiremote ? (root.instances ?? []).map((name) => root.getInstance(name)) : [root]
}

/** Options both configs share: mocha, budgets, reporters, binary check, launcher and purge. */
export const sharedConfig = {
  runner: 'local',
  framework: 'mocha',
  waitforTimeout: EXPECT_TIMEOUT_MS,
  connectionRetryTimeout: 120_000,
  logLevel: 'warn',
  connectionRetryCount: 1,
  specFileRetries: IS_CI ? 2 : 0,
  mochaOpts: { ui: 'bdd', timeout: TEST_TIMEOUT_MS },
  reporters: ['spec', [E2eJunitReporter, { outputDir: join(packageRoot, 'test-results/e2e') }]],
  async onPrepare(): Promise<void> {
    startRun()
    const binary = binaryPath()
    if (!existsSync(binary)) {
      throw new Error(
        `E2E binary not found: ${binary}. Run pnpm build:e2e or set MEMRY_E2E_BINARY.`
      )
    }
    await verifyE2eBinary(binary)
  },
  async onWorkerStart(cid: string, caps: unknown): Promise<void> {
    await startWorkerApps(cid, caps)
  },
  onWorkerEnd(cid: string): void {
    const started = workerApps.get(cid)
    for (const child of started?.children ?? []) if (child.pid) forceKill(child.pid)
    for (const port of started?.ports ?? []) {
      removeDir(join(tmpdir(), 'memry-e2e', `default-${port}`))
    }
    workerApps.delete(cid)
  },
  // The last test disposes its app, and WebdriverIO ends the session after this hook with a
  // DELETE that fails on a dead port or an unknown session. Leave a placeholder app with an
  // open session behind.
  async after(): Promise<void> {
    for (const session of sessions()) {
      const port = session.options.port
      if (!port) continue
      if (!(await driverReady(port))) await spawnApp(port)
      await session.reloadSession()
    }
  },
  onComplete(): void {
    purgeAllCreatedDevices()
  }
} as const
