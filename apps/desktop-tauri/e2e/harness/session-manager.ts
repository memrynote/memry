/**
 * A fake desktop session manager on the session bus (`fake-session-manager.py`), for the Linux
 * logout specs. It must own its bus name before the app starts, because the app registers with
 * the session manager at launch.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { HarnessError } from './errors'
import { pollUntil } from './wait'

export type Desktop = 'gnome' | 'xfce'

export interface SessionManagerEvent {
  event: string
  [field: string]: unknown
}

export interface FakeSessionManager {
  readonly events: SessionManagerEvent[]
  /** The first event named `event` that `matches`, once it has arrived. */
  waitFor(
    event: string,
    matches?: (event: SessionManagerEvent) => boolean,
    timeoutMs?: number
  ): Promise<SessionManagerEvent>
  /** Starts a logout for the registered client with process id `pid`. */
  logout(pid: number): void
  stop(): void
}

const SCRIPT = fileURLToPath(new URL('./fake-session-manager.py', import.meta.url))

export async function startFakeSessionManager(desktop: Desktop): Promise<FakeSessionManager> {
  const child = spawn('python3', [SCRIPT, desktop], { stdio: ['pipe', 'pipe', 'inherit'] })
  const events: SessionManagerEvent[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    events.push(JSON.parse(line) as SessionManagerEvent)
  })
  const manager: FakeSessionManager = {
    events,
    async waitFor(event, matches = () => true, timeoutMs = 10_000) {
      const found = await pollUntil(() => events.find((e) => e.event === event && matches(e)), {
        timeoutMs,
        intervalMs: 50
      })
      if (!found) {
        throw new HarnessError(
          `the fake session manager saw no "${event}"; it saw ${JSON.stringify(events)}`
        )
      }
      return found
    },
    logout(pid) {
      child.stdin.write(`logout ${pid}\n`)
    },
    stop() {
      child.kill()
    }
  }
  await manager.waitFor('ready')
  return manager
}
