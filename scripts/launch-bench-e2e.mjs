// The e2e side of the launch bench (#3557, cause H2 of #3547). An `e2e` build with `MEMRY_E2E=1`
// takes its data dir, log dir and device from `<tmp>/memry-e2e/control-<port>.json` and ignores
// `MEMRY_APP_DATA_DIR` (`memry_desktop::e2e::control`). The web view store is named after the data
// dir, so a launch on any other profile reads another, empty tab state. On such a build the bench
// points the control file at `--profile`, opens one note there over WebDriver, and measures on
// that same file.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '../apps/desktop-tauri/scripts/lib/webdriver-client.mjs'

// `memry_desktop::e2e::control::DEFAULT_PORT`, used when `TAURI_WEBDRIVER_PORT` is not a port.
const DEFAULT_PORT = 4445
const POLL_MS = 250
const PRIME_DEADLINE_MS = 60_000
// A call to a hung app never answers (the client's `fetch` has no timeout), so the whole priming
// has a bound of its own.
const PRIME_TOTAL_MS = 150_000
// The key prefix of the vault-scoped tab state in the web view's localStorage.
const TAB_STATE_PREFIX = 'memry_tab_state:'

export function webdriverPort(env) {
  const raw = env.TAURI_WEBDRIVER_PORT ?? ''
  return /^\d+$/.test(raw) && Number(raw) <= 65_535 ? Number(raw) : DEFAULT_PORT
}

export function controlFilePath(tmp, port) {
  return path.join(tmp, 'memry-e2e', `control-${port}.json`)
}

/** The harness's control file (`ControlFile`): this profile, its logs, the bench device. */
export function e2eControl(env, profile) {
  return {
    appDataDir: profile,
    logDir: path.join(profile, 'logs'),
    device: env.MEMRY_DEVICE,
    testVaultPath: null,
    syncServerUrl: null,
    extraEnv: {}
  }
}

/** Writes the control file of the bench's WebDriver port and returns where and what. */
export function writeE2eControl(env, profile, tmp = tmpdir()) {
  const file = controlFilePath(tmp, webdriverPort(env))
  const control = e2eControl(env, profile)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(control))
  return { file, control }
}

function readControlProfile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).appDataDir ?? null
  } catch {
    return undefined
  }
}

/**
 * Throws unless the control file the app is about to read names `profile`. The bench writes it
 * once, but an e2e spec or `agent-app.mjs` on the same port rewrites or removes its file, and the
 * next launch would then run on another profile without a word.
 */
export function assertControlNamesProfile(file, profile) {
  const named = readControlProfile(file)
  if (named === profile) {
    return
  }
  const state = named === undefined ? 'is missing or unreadable' : `names ${named}`
  throw new Error(
    `MEMRY_E2E=1 makes the app read ${file} and ignore MEMRY_APP_DATA_DIR, and that file ${state}, not ${profile}. ` +
      'Stop the e2e run or agent-app on that port or set TAURI_WEBDRIVER_PORT to a free port, then rerun the bench (it writes the file); or unset MEMRY_E2E to measure a release build.'
  )
}

/** Removes the control file when it is still the bench's. */
export function removeE2eControl(file, profile) {
  if (readControlProfile(file) === profile) {
    rmSync(file, { force: true })
  }
}

// An async function body run in the page. The result travels as `{ ok, value | failure }`, not
// `{ error }`, which WebDriver would read as a failed command and send again.
const inPage = (body) => `const [args, done] = arguments;
  (async () => { ${body} })().then(
    (value) => done({ ok: true, value: value ?? null }),
    (failure) => done({ ok: false, failure: String(failure?.message ?? failure) }))`

const VAULT_IS_OPEN = inPage(
  "return (await window.__TAURI__.core.invoke('vault_get_status')).isOpen"
)
const FIRST_NOTE = inPage(`
  const { notes } = await window.__TAURI__.core.invoke('notes_list', { options: { limit: 50 } });
  const note = notes.find((candidate) => !candidate.fileType || candidate.fileType === 'markdown');
  return note ? { id: note.id, title: note.title } : null`)
// The tab opens through the renderer's test event, which has no queue: it is dispatched on every
// poll until the tab renders, since it can land before the listener mounts. Not after that: each
// dispatch touches the tab state and restarts its 1 s save debounce, so it would never be stored.
const OPEN_NOTE = inPage(`
  const rendered = [...document.querySelectorAll('[role="tab"][data-group-id]')].some((tab) => tab.textContent.includes(args.title));
  if (!rendered) {
    window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail: { id: args.id, title: args.title } }));
    return false;
  }
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key.startsWith('${TAB_STATE_PREFIX}') && localStorage.getItem(key).includes(args.id)) return true;
  }
  return false`)

async function until(what, read, stillRunning, hint = 'is this an e2e build?') {
  const deadline = Date.now() + PRIME_DEADLINE_MS
  let lastError = null
  while (stillRunning()) {
    try {
      const value = await read()
      if (value) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      const cause = lastError ? ` (${lastError.message})` : ''
      throw new Error(`${what}: not within ${PRIME_DEADLINE_MS} ms${cause}; ${hint}`)
    }
    await delay(POLL_MS)
  }
  throw new Error(`the app exited before ${what}`)
}

/**
 * Opens the first note of the vault in a running e2e build and waits until its tab state is
 * stored, so the next launch on the profile restores it. Resolves with the note's id.
 */
export async function openOneNote(port, stillRunning) {
  const stop = new AbortController()
  const overdue = delay(PRIME_TOTAL_MS, null, { signal: stop.signal }).then(() => {
    throw new Error(`the app did not open a note within ${PRIME_TOTAL_MS} ms`)
  })
  try {
    return await Promise.race([prime(port, stillRunning), overdue])
  } finally {
    stop.abort()
  }
}

async function prime(port, stillRunning) {
  const client = createClient(`http://127.0.0.1:${port}`)
  await until(
    `the WebDriver server on port ${port} was ready`,
    async () => (await client.status()).ready === true,
    stillRunning
  )
  const session = await client.newSession()
  const run = async (script, args) => {
    const reply = await client.executeAsync(session, script, [args])
    if (!reply?.ok) {
      throw new Error(reply?.failure ?? 'no reply from the page')
    }
    return reply.value
  }
  await until('the vault opened', () => run(VAULT_IS_OPEN), stillRunning)
  // The vault reports open before its index lists notes.
  const note = await until(
    'the vault listed a note',
    () => run(FIRST_NOTE),
    stillRunning,
    'seed the bench vault first (pnpm seed1k)'
  )
  await until('the tab state named the note', () => run(OPEN_NOTE, note), stillRunning)
  return note.id
}
