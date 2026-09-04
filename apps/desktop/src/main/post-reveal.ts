// Post-reveal startup queue.
//
// Work registered here is startup work the first frame does not depend on. It
// runs after the main window is on screen, so it can no longer sit between
// `createWindow()` and the reveal and push out the moment the user stops
// staring at nothing (#2001).
import { isAppShuttingDown } from './app-shutdown'
import { createLogger } from './lib/logger'

const postRevealLog = createLogger('Startup')

// The reveal fires on 'ready-to-show', which means the renderer can paint, not
// that it has finished booting: its own IPC round-trips keep the main thread
// busy for a few hundred milliseconds afterwards. Draining on the next tick
// would move the contention rather than remove it, so wait out that window.
export const POST_REVEAL_DELAY_MS = 1_000

type PostRevealTask = () => void | Promise<void>

const queue = new Map<string, PostRevealTask>()
const started = new Set<string>()
let scheduled = false
let drained = false

const runTask = (name: string, task: PostRevealTask): void => {
  if (started.has(name)) return
  started.add(name)
  try {
    const result = task()
    if (result instanceof Promise) {
      void result.catch((error) => {
        postRevealLog.warn(`deferred startup task failed: ${name}`, error)
      })
    }
  } catch (error) {
    postRevealLog.warn(`deferred startup task failed: ${name}`, error)
  }
}

/**
 * Register startup work to run once the main window is visible. `name` is the
 * at-most-once key: a macOS dock reopen re-enters window creation and reveal, so
 * a caller on that path registering again must not start a second copy.
 */
export const onceWindowShown = (name: string, task: PostRevealTask): void => {
  if (started.has(name)) return
  if (drained) {
    runTask(name, task)
    return
  }
  queue.set(name, task)
}

/** Arm the drain. Called from the reveal; repeat reveals are no-ops. */
export const schedulePostRevealTasks = (): void => {
  if (scheduled) return
  scheduled = true
  const timer = setTimeout(() => {
    // A quit inside the delay has already torn down the services these tasks
    // would arm; starting them now is the mid-shutdown re-arm app-shutdown
    // exists to prevent. Stay undrained so nothing registered later starts either.
    if (isAppShuttingDown()) return
    drained = true
    const pending = [...queue]
    queue.clear()
    for (const [name, task] of pending) runTask(name, task)
  }, POST_REVEAL_DELAY_MS)
  timer.unref?.()
}
