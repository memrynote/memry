// The app process of the launch bench: start it, quit it, kill it.
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { assertLaunchProfile } from './launch-bench-e2e.mjs'

const QUIT_DEADLINE_MS = 20_000

/** Every launch of the bench goes through here, so none runs on an e2e control file that went. */
export function launch(executable, env) {
  assertLaunchProfile(env)
  const child = spawn(executable, [], { env, stdio: 'ignore' })
  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  return { child, exited }
}

export function forceKill({ child }) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

/** Asks the app to quit (SIGTERM starts its shutdown; Windows gets WM_CLOSE), then forces it. */
export async function quit(app) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(app.child.pid)], { stdio: 'ignore' })
  } else {
    app.child.kill('SIGTERM')
  }
  const timedOut = Symbol('timeout')
  const outcome = await Promise.race([app.exited, delay(QUIT_DEADLINE_MS).then(() => timedOut)])
  if (outcome !== timedOut) {
    return null
  }
  forceKill(app)
  await app.exited
  return `the app did not quit within ${QUIT_DEADLINE_MS} ms and was killed`
}
