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
 * Instead the app ships a dev-build-only switch reachable by deep link
 * (`memry:///dev-network?offline=1`), which makes the HTTP adapter report
 * offline and reject every request: `isOnline()` false, requests failing,
 * outbox parked and retried. It cannot make the app behave BETTER than real
 * airplane mode, which is the property a gate needs. The offline flow asserts
 * the app's own Offline banner, so a pass cannot quietly have run online.
 *
 * On real hardware there is no such lever for the radio, so `--device` prompts
 * for a manual airplane-mode toggle — slower, and honest.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = resolve(here, '..')
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
  // The app's own switch. `openurl` does not navigate — the root layout
  // handles this link without touching the current screen — so a transition
  // mid-flow leaves the app exactly where the flow left it.
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    UDID,
    `memry:///dev-network?offline=${online ? '0' : '1'}`
  ])
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
