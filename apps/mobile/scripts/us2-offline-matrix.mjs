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
 *   node scripts/us2-offline-matrix.mjs --runs 20 --udid <simulator-udid>
 *   node scripts/us2-offline-matrix.mjs --runs 20 --device   # real hardware
 *
 * On real hardware there is no scriptable airplane-mode switch, so `--device`
 * pauses for a manual toggle at each transition and prints what to do. That is
 * slower and it is the honest option: a matrix that silently skipped the
 * offline half would be worse than one that asks.
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
const ON_DEVICE = args.includes('--device')

const rl = ON_DEVICE ? createInterface({ input: process.stdin, output: process.stdout }) : null

async function setNetwork(online) {
  if (ON_DEVICE) {
    await rl.question(
      `\n  >> Turn airplane mode ${online ? 'OFF' : 'ON'} on the device, then press Enter. `
    )
    return
  }
  // The simulator's status bar override is the only lever that reaches the
  // app's own reachability checks; `simctl` has no radio switch.
  execFileSync('xcrun', [
    'simctl',
    'status_bar',
    UDID,
    'override',
    '--dataNetwork',
    online ? 'wifi' : 'hide',
    '--cellularMode',
    online ? 'active' : 'notSupported'
  ])
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
