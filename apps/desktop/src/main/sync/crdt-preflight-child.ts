/**
 * CRDT store preflight — runs in a disposable child process.
 *
 * A broken classic-level native binding (wrong ABI, unsupported CPU
 * instructions, AV interference) can abort the process outright — no JS error,
 * no uncaughtException, nothing to catch. Observed in the wild on 2026.709.x:
 * the main process died silently seconds after launch, before the window ever
 * painted. So the binding is exercised HERE first — on the REAL store
 * directory, so corrupt on-disk state (torn LDB/MANIFEST from a past crash or
 * full disk) dies here too, not just a binding that is broken outright. If
 * this process dies, main never loads the binding; it quarantines the store
 * and re-probes, or degrades to in-memory mode instead of vanishing.
 *
 * The stage markers matter as much as the exit code: a child that dies before
 * `started` never ran at all (its runtime failed to boot), which is no verdict
 * on the store. See crdt-preflight-protocol.ts.
 *
 * Keep this file free of project imports (bar the protocol constants) and
 * `electron` — it must stay a minimal, standalone bundle that only touches
 * y-leveldb/yjs and node builtins, and it runs under `ELECTRON_RUN_AS_NODE`
 * too, where `electron` does not exist.
 */
import { writeSync } from 'fs'
import { createRequire } from 'module'
import * as Y from 'yjs'
import {
  PREFLIGHT_MARK_BINDING_LOADED,
  PREFLIGHT_MARK_STARTED,
  PREFLIGHT_MARK_STORE_OPS
} from './crdt-preflight-protocol'

const PROBE_DOC = '__memry_preflight__'

function mark(marker: string): void {
  // writeSync, not process.stderr.write: stderr is a pipe here, so Node's
  // stream write is async and a native abort microseconds later would eat the
  // marker — which is the exact moment the parent needs it.
  writeSync(2, `${marker}\n`)
}

async function main(): Promise<void> {
  mark(PREFLIGHT_MARK_STARTED)

  // E2E reproduction of the field failure: a hard native-style abort while the
  // binding loads. Honored only under the test harness (NODE_ENV=test); inert
  // in shipped builds.
  if (process.env.NODE_ENV === 'test' && process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH === '1') {
    process.abort()
  }

  const probeDir = process.argv[2]
  if (!probeDir) {
    throw new Error('crdt-preflight-child: missing probe directory argument')
  }

  // Loaded lazily so the `started` marker is out before the native binding is
  // touched: a binding that aborts on load is then distinguishable from a
  // child runtime that never started. `require`, not `import()` — y-leveldb is
  // an external dep resolved relative to this bundle, and CJS require is what
  // works from inside the packaged app.
  const { LeveldbPersistence } = createRequire(__filename)(
    'y-leveldb'
  ) as typeof import('y-leveldb')
  mark(PREFLIGHT_MARK_BINDING_LOADED)

  // This is the user's real store: round-trip a throwaway probe doc, clear it,
  // and close cleanly (releasing the LevelDB LOCK for main). Never delete the
  // directory — quarantine decisions belong to the provider in main.
  //
  // Each operation announces itself BEFORE it runs: a native access violation
  // unwinds nothing, so the only way to name the failing operation is to have
  // already said which one is starting.
  mark(PREFLIGHT_MARK_STORE_OPS.open)
  const persistence = new LeveldbPersistence(probeDir)
  const doc = new Y.Doc()
  doc.getMap('probe').set('ok', true)
  mark(PREFLIGHT_MARK_STORE_OPS.write)
  await persistence.storeUpdate(PROBE_DOC, Y.encodeStateAsUpdate(doc))
  doc.destroy()

  mark(PREFLIGHT_MARK_STORE_OPS.read)
  const loaded = await persistence.getYDoc(PROBE_DOC)
  loaded.destroy()

  mark(PREFLIGHT_MARK_STORE_OPS.clear)
  await persistence.clearDocument(PROBE_DOC)
  mark(PREFLIGHT_MARK_STORE_OPS.close)
  await persistence.destroy()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
