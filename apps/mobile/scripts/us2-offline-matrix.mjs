#!/usr/bin/env node
/**
 * US2 offline matrix driver (T066).
 *
 * Runs the offline matrix N times and reports N/N. Maestro cannot toggle the
 * radio — neither the simulator nor a device exposes airplane mode to the
 * accessibility tree — so the network transitions live here, and the scenario
 * is TWO flows with the transition between them:
 *
 *   1. cut the data network,
 *   2. `us2-offline-matrix.yaml` — edit + create + force-quit + relaunch,
 *      all offline (it asserts the Offline banner, so a pass cannot quietly
 *      have run online),
 *   3. restore the network,
 *   4. `us2-offline-reconnect.yaml` — wait for the Offline banner to clear,
 *      THEN for the outbox to drain.
 *
 * One file would mean restoring the network only after the flow exited, so the
 * reconnect assertions would run offline and pass vacuously: the Offline
 * banner pre-empts the outbox banner, making `notVisible` trivially true while
 * nothing had synced. That is a false green on the gate the matrix exists for.
 *
 *   node scripts/us2-offline-matrix.mjs --doctor                   # preflight
 *   node scripts/us2-offline-matrix.mjs --runs 20                 # simulator
 *   node scripts/us2-offline-matrix.mjs --runs 20 --device        # hardware
 *   node scripts/us2-offline-matrix.mjs --runs 20 \
 *     --offline-cmd '<take the host offline>' --online-cmd '<put it back>'
 *
 * THE NETWORK CUT COMES FROM THE APP, not from `simctl`.
 * `xcrun simctl status_bar override --dataNetwork hide` only repaints the
 * status bar — the simulator stays fully online — so a run driven by it does
 * all of its "offline" work with a working network and reports a green that
 * means nothing.
 *
 * Instead the app ships a dev-build-only switch backed by a marker FILE in its
 * document directory. While it exists the HTTP adapter reports offline and
 * rejects every request: `isOnline()` false, requests failing, outbox parked
 * and retried. It cannot make the app behave BETTER than real airplane mode,
 * which is the property a gate needs, and the offline flow asserts the app's
 * own Offline banner so a pass cannot quietly have run online.
 *
 * A file rather than a deep link, which was tried first and does not work:
 * under the dev-client shell the `memry://` scheme is consumed by the launcher
 * and the running app never sees the URL. A file needs no scheme, no UI and no
 * running app, and it survives the force-quit the scenario depends on.
 *
 * On real hardware the data container is not writable from the host, so
 * `--device` prompts for a manual airplane-mode toggle — slower, and honest.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = resolve(here, '..')
const APP_ID = 'com.memry.mobile'
const offlineFlow = join(mobileRoot, '.maestro/us2-offline-matrix.yaml')
const reconnectFlow = join(mobileRoot, '.maestro/us2-offline-reconnect.yaml')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const RUNS = Number(flag('runs', '20'))
const UDID = flag('udid', 'booted')
const OFFLINE_CMD = flag('offline-cmd', null)
const ONLINE_CMD = flag('online-cmd', null)
const ON_DEVICE = args.includes('--device')

const rl = ON_DEVICE ? createInterface({ input: process.stdin, output: process.stdout }) : null

async function setNetwork(online) {
  const command = online ? ONLINE_CMD : OFFLINE_CMD
  if (command) {
    execFileSync('/bin/sh', ['-c', command], { stdio: 'inherit' })
    return
  }
  if (ON_DEVICE) {
    await rl.question(
      `\n  >> Turn airplane mode ${online ? 'OFF' : 'ON'} on the device, then press Enter. `
    )
    return
  }

  // The app's own switch, written straight into its document directory. No
  // scheme, no UI, no navigation — the app is left exactly where the flow left
  // it, and the marker survives the force-quit the scenario depends on.
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, APP_ID, 'data'])
    .toString()
    .trim()
  const markerPath = join(container, 'Documents', '.dev-offline')
  if (online) rmSync(markerPath, { force: true })
  else writeFileSync(markerPath, '1')
  // Cosmetic, and only that: it makes a screen recording of the run show the
  // state the app is actually in.
  try {
    execFileSync('xcrun', [
      'simctl',
      'status_bar',
      UDID,
      'override',
      '--dataNetwork',
      online ? 'wifi' : 'hide'
    ])
  } catch {
    // A status-bar override failing changes nothing about the run.
  }
}

function runFlow(flow, runId) {
  const result = spawnSync('maestro', ['test', flow, '-e', `RUN_ID=${runId}`], {
    cwd: mobileRoot,
    stdio: 'inherit',
    env: process.env
  })
  return result.status === 0
}

/**
 * Preflight.
 *
 * The expensive part of this gate is not the runs, it is the ONE manual step
 * in front of them — unlocking the vault. A driver that dies on run 1 because
 * Java is missing or the app is not installed has wasted that. So everything
 * checkable is checked first, and the report says which piece is missing
 * rather than making you read a stack trace.
 */
function doctor() {
  const checks = []
  const ok = (name, detail) => checks.push({ name, pass: true, detail })
  const bad = (name, detail) => checks.push({ name, pass: false, detail })

  try {
    execFileSync('xcrun', ['simctl', 'help'], { stdio: 'ignore' })
    ok('xcrun simctl', 'available')
  } catch {
    bad('xcrun simctl', 'not found — install Xcode command line tools')
  }

  try {
    const out = execFileSync('maestro', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
      .toString()
      .trim()
    ok('maestro', out.split('\n').pop())
  } catch (err) {
    const message = String(err?.stderr ?? err?.message ?? err)
    bad(
      'maestro',
      /Java/i.test(message)
        ? 'needs a Java runtime — `brew install openjdk` and export JAVA_HOME=/opt/homebrew/opt/openjdk'
        : 'not runnable'
    )
  }

  if (!ON_DEVICE) {
    try {
      const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, APP_ID, 'data'])
        .toString()
        .trim()
      ok(`${APP_ID} installed`, container)

      // The lever itself, exercised for real rather than assumed.
      const markerPath = join(container, 'Documents', '.dev-offline')
      writeFileSync(markerPath, '1')
      const wrote = existsSync(markerPath)
      rmSync(markerPath, { force: true })
      const cleared = !existsSync(markerPath)
      if (wrote && cleared) ok('offline switch', 'marker writes and clears')
      else bad('offline switch', 'could not write or clear the marker file')
    } catch {
      bad(
        `${APP_ID} installed`,
        'no app on the simulator — run `pnpm --filter @memry/mobile ios` first'
      )
    }
  }

  for (const check of checks) {
    console.log(`${check.pass ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(24)} ${check.detail}`)
  }
  console.log(
    '\nNot checkable from here: the vault has to be UNLOCKED on the device.' +
      '\nIts recovery phrase is the only key, so that step is yours; after it the' +
      '\nsession persists and the runs are unattended.'
  )
  return checks.every((check) => check.pass)
}

if (args.includes('--doctor')) {
  rl?.close()
  process.exit(doctor() ? 0 : 1)
}

const failures = []
for (let run = 1; run <= RUNS; run++) {
  console.log(`\n=== offline matrix run ${run}/${RUNS} ===`)

  await setNetwork(false)
  const offlinePassed = runFlow(offlineFlow, run)

  // Restored regardless of the offline half's outcome: a failed run must not
  // leave the next one starting from an unknown network state.
  await setNetwork(true)

  // The reconnect half only runs if the offline half actually produced the
  // edits it is meant to sync. Running it anyway would report a sync failure
  // for a run that never wrote anything.
  const passed = offlinePassed && runFlow(reconnectFlow, run)
  if (!passed) failures.push(run)
}

rl?.close()

const passed = RUNS - failures.length
console.log(`\noffline matrix: ${passed}/${RUNS} passed`)
if (failures.length > 0) {
  console.error(`failed runs: ${failures.join(', ')}`)
  process.exit(1)
}
