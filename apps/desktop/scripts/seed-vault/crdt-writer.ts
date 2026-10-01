import { createRequire } from 'node:module'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { CRDT_LEVEL_OPTIONS } from '../../src/main/sync/crdt-persistence'

interface LevelInstance {
  open(): Promise<void>
}
type LevelAdapter = new (location: string, options: Record<string, unknown>) => LevelInstance

function isLockedError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as NodeJS.ErrnoException).code === 'LEVEL_LOCKED') return true
  }
  return false
}

/**
 * Store each doc's full state the way `seedFromMarkdown` stores a seeded doc
 * (`storeUpdate(noteId, Y.encodeStateAsUpdate(doc))`), then load every one
 * back through `getYDoc` and hand it to `check`. Throws, naming the store,
 * when the store is held by a running app or a loaded doc fails the check.
 */
export async function writeCrdtDocs(
  storeDir: string,
  docs: Array<{ noteId: string; doc: Y.Doc; check: (loaded: Y.Doc) => string[] }>
): Promise<void> {
  // Every y-leveldb method swallows its errors (console.warn, resolve null),
  // so a locked store would read back as empty with the cause never shown.
  // Opening the adapter first is the one rejection that can be read; same
  // approach, and same `level` resolved through y-leveldb, as
  // src/main/sync/crdt-preflight-child.ts.
  const yLeveldbPath = createRequire(import.meta.url).resolve('y-leveldb')
  const { Level } = createRequire(yLeveldbPath)('level') as { Level: LevelAdapter }
  let adapter: LevelInstance | undefined
  class CapturingLevel extends Level {
    constructor(location: string, options: Record<string, unknown>) {
      super(location, options)
      adapter = this
    }
  }
  const persistence = new LeveldbPersistence(storeDir, {
    Level: CapturingLevel,
    levelOptions: CRDT_LEVEL_OPTIONS
  })
  try {
    if (!adapter) throw new Error('y-leveldb ignored the injected Level adapter')
    try {
      await adapter.open()
    } catch (error) {
      if (!isLockedError(error)) throw error
      throw new Error(
        `The CRDT store at ${storeDir} is locked by another process (is memrynote running on this profile?). Quit it and re-run the seed.`,
        { cause: error }
      )
    }
    for (const { noteId, doc } of docs) {
      await persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
    }
    for (const { noteId, check } of docs) {
      const loaded = await persistence.getYDoc(noteId)
      const problems = check(loaded)
      loaded.destroy()
      if (problems.length > 0) {
        throw new Error(`Stored doc ${noteId} failed its check:\n  ${problems.join('\n  ')}`)
      }
    }
  } finally {
    await persistence.destroy()
  }
}
