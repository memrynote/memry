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
 *   node scripts/us2-offline-matrix.mjs --runs 20
 *   node scripts/us2-offline-matrix.mjs --runs 20 \
 *     --offline-cmd 'sudo pfctl -e -f /etc/pf.memry-offline.conf' \
 *     --online-cmd  'sudo pfctl -d'
 *
 * THE NETWORK CUT IS NOT AUTOMATED BY DEFAULT, and that is deliberate.
 * `xcrun simctl status_bar override --dataNetwork hide` only repaints the
 * status bar — the simulator stays fully online — so a run driven by it would
 * do all of its "offline" work with a working network and report a green that
 * means nothing. The offline flow asserts the app's own Offline banner for the
 * same reason.
 *
 * So each transition either runs the command you supplied (`--offline-cmd` /
 * `--online-cmd`, for a host firewall rule or a Network Link Conditioner
 * profile) or pauses and asks you to toggle it. Slower, and honest: a matrix
 * that silently skipped the offline half is worse than one that asks.
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
const OFFLINE_CMD = flag('offline-cmd', null)
const ONLINE_CMD = flag('online-cmd', null)
const SCRIPTED = Boolean(OFFLINE_CMD && ONLINE_CMD)

const rl = SCRIPTED ? null : createInterface({ input: process.stdin, output: process.stdout })

async function setNetwork(online) {
  const command = online ? ONLINE_CMD : OFFLINE_CMD
  if (command) {
    execFileSync('/bin/sh', ['-c', command], { stdio: 'inherit' })
    return
  }
  await rl.question(
    `\n  >> Take the device ${online ? 'ONLINE' : 'OFFLINE'} (airplane mode, or your host's` +
      ` network conditioner), then press Enter. `
  )
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
