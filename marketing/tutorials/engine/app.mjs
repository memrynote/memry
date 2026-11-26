// The app under the camera: the test-mode Tauri build, started by agent-app.mjs on a copy of the
// tutorial vault. The recorder (screen-rec.mjs) sizes the window to the film when a take starts.
// `appRoot` is the checkout whose build is filmed (see build.mjs --app). TAURI_WEBDRIVER_PORT
// picks the app's WebDriver port (clip.mjs sets it per slot).
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

let agentApp

const run = (args, env = {}) =>
  execFileSync('node', [agentApp, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

export function useApp(appRoot) {
  agentApp = path.join(appRoot, 'apps/desktop-tauri/scripts/agent-app.mjs')
}

/** The binary agent-app starts and the command that builds it. */
export async function appBuild() {
  const { defaultBinary } = await import(pathToFileURL(agentApp).href)
  return {
    binary: process.env.MEMRY_AGENT_BINARY ?? defaultBinary(),
    command: 'pnpm --filter @memry/desktop-tauri build:e2e'
  }
}

export function startApp(vault) {
  run(['stop'])
  const out = run(['start'], { MEMRY_AGENT_VAULT_TEMPLATE: vault })
  if (!out.includes(path.basename(vault))) {
    throw new Error(`agent-app did not open ${vault}:\n${out}`)
  }
}

export const stopApp = () => run(['stop'])

/** Read-only SQL on the running app's data.db, as rows. */
export const query = (sql) => JSON.parse(run(['query', sql]))
