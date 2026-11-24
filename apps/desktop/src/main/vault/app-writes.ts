/**
 * The bytes Memry wrote, or is writing, to each vault file, so the watcher can
 * tell the echo of its own write from an edit made outside the app (#5605).
 *
 * The watcher used to drop every event on a path for 5 s after the app wrote
 * it, whatever the file then held. An edit another editor, a script or a sync
 * client made in that window was not taken in until some later ingest found
 * it, and that ingest replaced the body with the file, erasing what the doc
 * had gained since.
 *
 * Now a writer records the bytes before it writes them (`recordAppWrite`) and
 * reports when they land. The watcher reads the file an event names and drops
 * the event only when the file held bytes of the app's while it read them:
 * a write in flight, or the last one that landed. The file keeps those until
 * the next write's rename, and a read that began before a later write landed
 * may still return them. Any other bytes are an edit, however soon after an
 * app write, and once the watcher reads them, the bytes the app wrote before
 * are no longer its own: an outside edit that puts them back is an edit too.
 *
 * Case twins write the file they share, each by its own spelling (#5624). A
 * write that lands supersedes the landed records of every spelling that names
 * the same file, so one twin's earlier bytes, put back from outside after the
 * other twin wrote, are an edit too.
 *
 * Records expire after `APP_WRITE_TTL_MS`. That only bounds the map: an
 * event comes about 200 ms after its write.
 *
 * @module vault/app-writes
 */

import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { foldNotePath } from '@memry/storage-data/note-metadata-repository'

/** What a writer puts in a file: its text (UTF-8), its bytes, or their sha256 in hex. */
export type AppBytes = string | Uint8Array | { sha256: string }

interface AppWrite {
  /** The path the writer named. */
  path: string
  /** sha256 of the bytes, or null for a move whose bytes were not read. */
  hash: string | null
  /** Wall clock, for expiry only. */
  recordedAt: number
  landed: { at: number; step: number } | null
  /** The `step` a later write of the path landed at, or the watcher read other bytes there. */
  supersededStep: number | null
}

const APP_WRITE_TTL_MS = 5000

/** By folded path: the spellings of one file on a case-insensitive disk share a list. */
const writesByFold = new Map<string, AppWrite[]>()
let sweptAt = 0
/**
 * Orders landings and reads. Two of them often fall in one millisecond, and a
 * read must know which came first.
 */
let step = 0

function sha256Of(bytes: AppBytes): string {
  if (typeof bytes === 'string') return createHash('sha256').update(bytes, 'utf8').digest('hex')
  if (bytes instanceof Uint8Array) return createHash('sha256').update(bytes).digest('hex')
  return bytes.sha256
}

function isLive(write: AppWrite, at: number): boolean {
  return at - (write.landed?.at ?? write.recordedAt) < APP_WRITE_TTL_MS
}

/**
 * The records under `fold` that have not expired, of every spelling. Every
 * path is swept at most once per TTL, from the write side too, so a stopped
 * watcher cannot leave the map growing by one entry per written file.
 */
function liveWrites(fold: string, now: number): AppWrite[] {
  if (now - sweptAt >= APP_WRITE_TTL_MS) {
    sweptAt = now
    for (const [swept, writes] of writesByFold) {
      const live = writes.filter((write) => isLive(write, now))
      if (live.length > 0) writesByFold.set(swept, live)
      else writesByFold.delete(swept)
    }
  }
  return (writesByFold.get(fold) ?? []).filter((write) => isLive(write, now))
}

function liveWritesAt(absolutePath: string, now: number): AppWrite[] {
  return liveWrites(foldNotePath(absolutePath), now).filter((write) => write.path === absolutePath)
}

function addWrite(write: AppWrite): void {
  const fold = foldNotePath(write.path)
  const live = liveWrites(fold, write.recordedAt)
  live.push(write)
  writesByFold.set(fold, live)
}

/**
 * Whether two spellings name one file, as on a case-insensitive disk. A
 * spelling that cannot be read counts as another file, which keeps its
 * records the app's until they expire, as before #5624.
 */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const first = statSync(a, { bigint: true, throwIfNoEntry: false })
    const second = statSync(b, { bigint: true, throwIfNoEntry: false })
    return !!first && !!second && first.dev === second.dev && first.ino === second.ino
  } catch {
    return false
  }
}

/**
 * Records `bytes` as the app's, about to be written to `absolutePath`. Call
 * the returned function once they are in the file. A write that fails, or a
 * writer that cannot tell when its bytes land, leaves them in flight, which
 * keeps them the app's until they expire.
 */
export function recordAppWrite(absolutePath: string, bytes: AppBytes): () => void {
  const write: AppWrite = {
    path: absolutePath,
    hash: sha256Of(bytes),
    recordedAt: Date.now(),
    landed: null,
    supersededStep: null
  }
  addWrite(write)
  return () => {
    const landed = { at: Date.now(), step: ++step }
    const fold = foldNotePath(absolutePath)
    const live = liveWrites(fold, landed.at)
    for (const earlier of live) {
      if (
        earlier.landed !== null &&
        earlier.supersededStep === null &&
        sameFile(earlier.path, absolutePath)
      ) {
        earlier.supersededStep = landed.step
      }
    }
    write.landed = landed
    if (!live.includes(write)) live.push(write)
    writesByFold.set(fold, live)
  }
}

/**
 * Records a move of a file to `absolutePath` whose bytes the mover did not
 * read: any bytes there count as the app's until the record expires. Only for
 * a file too large to hash where the move runs, since an outside edit inside
 * the window is dropped, as every edit was before #5605.
 */
export function recordAppMove(absolutePath: string): void {
  addWrite({
    path: absolutePath,
    hash: null,
    recordedAt: Date.now(),
    landed: null,
    supersededStep: null
  })
}

/**
 * Starts the check of a watcher event on `absolutePath`, before the file is
 * read. The returned function takes the bytes read: true when they are bytes
 * the app held in that file at some moment of the read. Null when the app
 * wrote nothing there lately, so nothing need be read.
 */
export function appWriteCheck(absolutePath: string): ((bytes: AppBytes) => boolean) | null {
  const atStart = liveWritesAt(absolutePath, Date.now())
  if (atStart.length === 0) return null
  const readStep = ++step
  return (bytes) => {
    const hash = sha256Of(bytes)
    const current = liveWritesAt(absolutePath, Date.now())
    const owned = (write: AppWrite): boolean =>
      (write.hash === null || write.hash === hash) &&
      (write.supersededStep === null || write.supersededStep > readStep)
    if (atStart.some(owned) || current.some(owned)) return true
    // What the file held when the read began is gone. A write that landed
    // during the read may be in the file now, so it stays the app's.
    for (const write of current) {
      if (write.landed && write.landed.step < readStep && write.supersededStep === null) {
        write.supersededStep = readStep
      }
    }
    return false
  }
}

/**
 * Whether the file at `absolutePath` holds bytes the app wrote there: the
 * echo of its own write, which the watcher drops. Reads it, in chunks, only
 * when the app wrote there lately. A file that cannot be read is no echo; the
 * event's handler deals with it.
 */
export async function fileHoldsAppWrite(absolutePath: string): Promise<boolean> {
  const check = appWriteCheck(absolutePath)
  if (check === null) return false
  const sha256 = await new Promise<string | null>((resolve) => {
    const hash = createHash('sha256')
    createReadStream(absolutePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', () => resolve(null))
  })
  return sha256 !== null && check({ sha256 })
}

/** Folded paths with a live record. Diagnostics: the size of the map is what the sweep bounds. */
export function appWriteCount(): number {
  return writesByFold.size
}

/** Drops every record, at vault close: no path of one vault belongs to the next. */
export function resetAppWrites(): void {
  writesByFold.clear()
  sweptAt = 0
}
