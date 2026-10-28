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
  /** The first event named `event`, once it has arrived. */
  waitFor(event: string, timeoutMs?: number): Promise<SessionManagerEvent>
  logout(): void
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
    async waitFor(event, timeoutMs = 10_000) {
      const found = await pollUntil(() => events.find((e) => e.event === event), {
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
    logout() {
      child.stdin.write('logout\n')
    },
    stop() {
      child.kill()
    }
  }
  await manager.waitFor('ready')
  return manager
}
