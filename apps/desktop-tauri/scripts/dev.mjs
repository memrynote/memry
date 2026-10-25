#!/usr/bin/env node
// Starts `tauri dev` against an environment: loads `apps/desktop-tauri/.env.<mode>` (gitignored;
// `pnpm env:link` links it into worktrees), merges it into the child environment without
// overriding variables already set, and sets MEMRY_ENV and MEMRY_DEVICE.
//
// With `--debug` the app is the e2e build with its WebDriver on port 9333, and a control file
// points it at a persistent profile (`~/.memry/staging-tauri-profile`), so a signed-in staging
// device survives restarts and does not add a new staging device per run.
//
//   node scripts/dev.mjs --mode=staging [--debug]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const DEBUG_PORT = 9333
const E2E_ARGS = ['--features', 'e2e', '--config', 'src-tauri/tauri.e2e.conf.json']

/** Parses `KEY=value` lines; `#` comments, blank lines, `export ` and quotes are handled. */
export function parseEnvFile(/** @type {string} */ text) {
  /** @type {Record<string, string>} */
  const values = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    values[match[1]] = value
  }
  return values
}

/**
 * The environment, tauri arguments and control file of one launch.
 *
 * @param {{ mode: string, debug: boolean, env: NodeJS.ProcessEnv, fileEnv: Record<string, string>, home: string }} options
 */
export function buildLaunch({ mode, debug, env, fileEnv, home }) {
  const childEnv = {
    // The renderer is not ported yet; every script that starts the app sets this.
    VITE_MEMRY_DEV_API_PROXY: '1',
    ...fileEnv,
    // What the caller already set wins over the file.
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    MEMRY_ENV: mode,
    MEMRY_DEVICE: 'dev'
  }
  const args = ['exec', 'tauri', 'dev']
  let control = null
  if (debug) {
    const profile = join(home, '.memry', 'staging-tauri-profile')
    Object.assign(childEnv, {
      MEMRY_E2E: '1',
      TAURI_WEBDRIVER_PORT: String(DEBUG_PORT),
      VITE_MEMRY_E2E: '1'
    })
    args.push(...E2E_ARGS)
    control = {
      appDataDir: join(profile, 'data'),
      logDir: join(profile, 'logs'),
      device: 'dev',
      testVaultPath: null,
      syncServerUrl: null,
      extraEnv: {}
    }
  }
  return { env: childEnv, args, control }
}

function readEnvFile(/** @type {string} */ mode) {
  try {
    return parseEnvFile(readFileSync(join(APP_DIR, `.env.${mode}`), 'utf8'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    console.warn(`dev: no apps/desktop-tauri/.env.${mode}; copy it from apps/desktop/.env.${mode}`)
    return {}
  }
}

export function main(/** @type {string[]} */ argv) {
  const mode =
    argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'development'
  const launch = buildLaunch({
    mode,
    debug: argv.includes('--debug'),
    env: process.env,
    fileEnv: readEnvFile(mode),
    home: homedir()
  })
  if (launch.control) {
    mkdirSync(launch.control.appDataDir, { recursive: true })
    mkdirSync(join(tmpdir(), 'memry-e2e'), { recursive: true })
    writeFileSync(
      join(tmpdir(), 'memry-e2e', `control-${DEBUG_PORT}.json`),
      JSON.stringify(launch.control)
    )
  }
  const child = spawn('pnpm', launch.args, { cwd: APP_DIR, env: launch.env, stdio: 'inherit' })
  // Ctrl+C reaches `tauri dev` through the terminal's process group; only a signal sent to this
  // process alone is passed on.
  process.on('SIGINT', () => {})
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP']))
    process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 0)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
