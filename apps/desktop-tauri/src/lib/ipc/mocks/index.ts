import type { MockRouteMap } from './types'
import { notesRoutes } from './notes'
import { tasksRoutes } from './tasks'
import { foldersRoutes } from './folders'
import { calendarRoutes } from './calendar'
import { inboxRoutes } from './inbox'
import { journalRoutes } from './journal'

/**
 * Aggregated route map for the mock IPC router.
 *
 * Each domain module (notes, tasks, calendar, ...) exports a `<domain>Routes`
 * object mapping command names to async handlers. This file composes all
 * domain route maps into the single registry consulted by `mockRouter`.
 *
 * Domains are added incrementally; any command not registered here raises
 * a descriptive error when invoked so missing mocks surface loudly during
 * renderer port-over.
 */
const routes: MockRouteMap = {
  ...notesRoutes,
  ...tasksRoutes,
  ...foldersRoutes,
  ...calendarRoutes,
  ...inboxRoutes,
  ...journalRoutes
}

/**
 * Dispatch a command through the mock IPC router. Called by `invoke` when
 * `shouldUseMock(cmd)` is true (default at M1).
 */
export async function mockRouter<T>(cmd: string, args?: unknown): Promise<T> {
  const handler = routes[cmd]
  if (!handler) {
    console.warn(`[mock-ipc] unimplemented command: ${cmd}`, args)
    throw new Error(`Mock IPC: command "${cmd}" not implemented`)
  }
  try {
    const result = await handler(args)
    return result as T
  } catch (err) {
    console.error(`[mock-ipc] handler error for "${cmd}":`, err)
    throw err
  }
}
