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
} from '@memry/sync-client/crdt-preflight-protocol'

const PROBE_DOC = '__memry_preflight__'

/** The one thing this file needs off a level adapter: an explicit open. */
interface LevelInstance {
  open(): Promise<void>
}
type LevelAdapter = new (location: string, options: Record<string, unknown>) => LevelInstance

/** How deep a cause chain is worth printing before it is noise. */
const MAX_CAUSE_DEPTH = 5

/**
 * The whole error chain on one line, root cause FIRST.
 *
 * abstract-level buries the diagnostic: a failed open rejects with
 * `Database is not open (LEVEL_DATABASE_NOT_OPEN)` and carries the LevelDB
 * message — the part that separates "another process holds the LOCK" from
 * "the store is corrupt" — only in `cause`. The parent keeps a bounded prefix
 * of this line as the failure reason, so the informative end leads.
 */
function describeErrorChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (current as { code?: unknown }).code
    parts.push(typeof code === 'string' ? `[${code}] ${current.message}` : current.message)
    current = (current as { cause?: unknown }).cause
  }
  if (parts.length === 0) return String(err)
  return parts.reverse().join(' <- ')
}

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
  const childRequire = createRequire(__filename)
  const { LeveldbPersistence } = childRequire('y-leveldb') as typeof import('y-leveldb')
  mark(PREFLIGHT_MARK_BINDING_LOADED)

  // y-leveldb opens its database lazily and never exposes the instance, so the
  // only way to see WHY an open failed is to hand it the adapter and keep a
  // reference. Resolved THROUGH y-leveldb's own resolution: the app's module
  // graph carries a second, newer classic-level, and probing the store with a
  // different native binding than the one y-leveldb will use proves nothing.
  const { Level } = createRequire(childRequire.resolve('y-leveldb'))('level') as {
    Level: LevelAdapter
  }
  const adapters: LevelInstance[] = []
  class CapturingLevel extends Level {
    constructor(location: string, options: Record<string, unknown>) {
      super(location, options)
      adapters.push(this)
    }
  }

  // This is the user's real store: round-trip a throwaway probe doc, clear it,
  // and close cleanly (releasing the LevelDB LOCK for main). Never delete the
  // directory — quarantine decisions belong to the provider in main.
  //
  // Each operation announces itself BEFORE it runs: a native access violation
  // unwinds nothing, so the only way to name the failing operation is to have
  // already said which one is starting.
  mark(PREFLIGHT_MARK_STORE_OPS.open)
  const persistence = new LeveldbPersistence(probeDir, { Level: CapturingLevel })
  const db = adapters[0]
  if (!db) {
    throw new Error('crdt-preflight: y-leveldb ignored the injected Level adapter')
  }
  // Open explicitly, before any y-leveldb call. Every y-leveldb method runs
  // inside `_transact`, which catches, console.warns and resolves `null` — so a
  // store that cannot be opened at all still walks through write and read
  // markers and only dies later on a null dereference, with the real error
  // (`IO error: lock <dir>/LOCK: already held by process`, `Corruption: ...`)
  // never printed. Observed in the field on 2026.909.1. This is the one call
  // whose rejection we can read.
  try {
    await db.open()
  } catch (err) {
    // writeSync for the same reason mark() uses it: this is the line the parent
    // needs most, and a native abort microseconds later would eat a buffered
    // stream write.
    writeSync(2, `crdt-preflight: store open failed: ${describeErrorChain(err)}\n`)
    throw err
  }

  const doc = new Y.Doc()
  doc.getMap('probe').set('ok', true)
  mark(PREFLIGHT_MARK_STORE_OPS.write)
  await persistence.storeUpdate(PROBE_DOC, Y.encodeStateAsUpdate(doc))
  doc.destroy()

  mark(PREFLIGHT_MARK_STORE_OPS.read)
  const loaded = await persistence.getYDoc(PROBE_DOC)
  // `null`, not a doc, means `_transact` swallowed the real error into a warn
  // line. Dereferencing it produced `TypeError: Cannot read properties of null`
  // — a verdict that named neither the store nor the cause.
  if (!loaded) {
    throw new Error(
      'crdt-preflight: store read returned null — y-leveldb swallowed a transaction error, see the lines above'
    )
  }
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
