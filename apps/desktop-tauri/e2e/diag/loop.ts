// DIAG #3973 (throwaway branch): launch the app over and over on one port and record stalls.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import { browser } from '@wdio/globals'

import { forceKill, isAlive } from '../harness/app-process'
import { type AppBrowser, appInfo, fresh, gracefulClose } from '../harness/tauri-lifecycle'

const ITERATIONS = Number(process.env.MEMRY_DIAG_ITERATIONS) || 40

function canBind(port: number): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve('free')))
  })
}

function portOwners(port: number): string {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? ''
  return out
    .split('\n')
    .filter((line) => line.includes(`127.0.0.1:${port} `) || line.includes(`0.0.0.0:${port} `))
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join(' | ')
}

function listenerPid(port: number): number | undefined {
  const line = portOwners(port)
    .split(' | ')
    .find((entry) => entry.includes('LISTENING') && entry.includes(`:${port} `))
  const pid = line ? Number(line.split(' ').at(-1)) : NaN
  return Number.isFinite(pid) && pid > 0 ? pid : undefined
}

export function loop(name: string): void {
  describe(`diag ${name}`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      it(`launch ${i}`, async () => {
        const executor = browser as unknown as AppBrowser
        const port = (executor as unknown as { options: { port: number } }).options.port
        // Measure the exit race: the old app is gone by GetExitCodeProcess; is its port free?
        let oldPid: number | undefined
        try {
          oldPid = (await appInfo({ executor })).pid
        } catch {
          oldPid = listenerPid(port)
        }
        if (oldPid !== undefined && i % 2 === 0) {
          await gracefulClose({ executor, pid: oldPid })
          const bind = await canBind(port)
          console.log(
            `DIAG exit-race ${name}#${i} port=${port} alive=${isAlive(oldPid)} bind=${bind}` +
              (bind === 'free' ? '' : ` owners=[${portOwners(port)}]`)
          )
        }
        const started = Date.now()
        try {
          const app = await fresh(executor, {
            extraEnv: i % 3 === 0 ? {} : { MEMRY_FORCE_VAULT_PICKER: '1' }
          })
          console.log(`DIAG ok ${name}#${i} pid=${app.pid} ms=${Date.now() - started}`)
        } catch (error) {
          console.log(
            `DIAG FAIL ${name}#${i} port=${port} ms=${Date.now() - started} owners=[${portOwners(port)}] ${String(error).slice(0, 400)}`
          )
          // Give the app-side capture time to finish, then clear the port.
          await new Promise((resolve) => setTimeout(resolve, 30_000))
          const stuck = listenerPid(port)
          if (stuck) forceKill(stuck)
        }
      })
    }
  })
}
