/**
 * CRDT store preflight — runs in a disposable Electron utilityProcess.
 *
 * A broken classic-level native binding (wrong ABI, unsupported CPU
 * instructions, AV interference) can abort the process outright — no JS error,
 * no uncaughtException, nothing to catch. Observed in the wild on 2026.709.x:
 * the main process died silently seconds after launch, before the window ever
 * painted. So the binding is exercised HERE first; if this process dies, main
 * never loads the binding and degrades to in-memory mode instead of vanishing.
 *
 * Keep this file free of project imports and `electron` — it must stay a
 * minimal, standalone bundle that only touches y-leveldb/yjs and node builtins.
 */
import { LeveldbPersistence } from 'y-leveldb'
import * as Y from 'yjs'
import { rmSync } from 'fs'

const PROBE_DOC = '__memry_preflight__'

async function main(): Promise<void> {
  // E2E reproduction of the field failure: a hard native-style abort. Honored
  // only under the test harness (NODE_ENV=test); inert in shipped builds.
  if (process.env.NODE_ENV === 'test' && process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH === '1') {
    process.abort()
  }

  const probeDir = process.argv[2]
  if (!probeDir) {
    throw new Error('crdt-preflight-child: missing probe directory argument')
  }

  const persistence = new LeveldbPersistence(probeDir)
  const doc = new Y.Doc()
  doc.getMap('probe').set('ok', true)
  await persistence.storeUpdate(PROBE_DOC, Y.encodeStateAsUpdate(doc))
  doc.destroy()

  const loaded = await persistence.getYDoc(PROBE_DOC)
  loaded.destroy()

  await persistence.clearDocument(PROBE_DOC)
  await persistence.destroy()
  rmSync(probeDir, { recursive: true, force: true })
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
