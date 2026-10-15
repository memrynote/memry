// The app under the camera: agent-app.mjs on a copy of the tutorial vault, 2x, 1600x900 (16:9).
// `appRoot` is the checkout whose desktop build is filmed (see build.mjs --app).
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

export const WINDOW = { width: 1600, height: 900, scale: 2 }
let agentApp

const run = (args, env = {}) =>
  execFileSync('node', [agentApp, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

export function useApp(appRoot) {
  agentApp = path.join(appRoot, 'apps/desktop/scripts/agent-app.mjs')
}

export function startApp(vault) {
  run(['stop'])
  const out = run(['start'], {
    MEMRY_AGENT_VAULT_TEMPLATE: vault,
    MEMRY_AGENT_SCALE: String(WINDOW.scale)
  })
  if (!out.includes(path.basename(vault))) {
    throw new Error(
      `agent-app did not open the tutorial vault. Is PR #3273 (MEMRY_AGENT_VAULT_TEMPLATE) in this checkout?\n${out}`
    )
  }
  mainEval(`(() => {
    const { BrowserWindow } = process.mainModule.require('electron')
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('renderer/index.html'))
      .setContentSize(${WINDOW.width}, ${WINDOW.height})
  })()`)
}

export const stopApp = () => run(['stop'])

/** Read-only SQL on the running app's data.db. */
export const query = (sql) => JSON.parse(mainEval(`__memryDebug.query(${JSON.stringify(sql)})`))

function mainEval(expression) {
  return run(['eval', expression]).trim()
}
