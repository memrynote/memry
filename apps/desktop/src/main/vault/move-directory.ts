/**
 * Move a vault directory, including one the vault watcher holds open.
 *
 * @module vault/move-directory
 */

import path from 'path'
import { constants, existsSync, type Dirent } from 'fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle
} from 'fs/promises'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { atomicWrite, withTransientFsRetry } from './file-ops'
import { getMemryDir, readVaultConfig } from './init'
import { clearStrandedFolders, holdStrandedFolder } from './app-folder-changes'
import { resolveVaultFile } from '../lib/paths'
import { createLogger } from '../lib/logger'

const logger = createLogger('MoveDirectory')

const LOCKED_TREE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function isLockedTreeError(error: unknown): boolean {
  return LOCKED_TREE_CODES.has(errnoCode(error) ?? '')
}

function isCaseOnlyRename(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase()
}

type UndoStep = () => Promise<unknown>

const STAGING_PREFIX = '.memry-move-'

/** A move's id, 6 random bytes in lowercase hex: its record's name and its staging directory's. */
const MOVE_ID = /^[0-9a-f]{12}$/

/** The most bytes a record holds, as in the Tauri app; a longer file is no record. */
const RECORD_MAX_BYTES = 4096

/** The most conflict or incomplete-move names tried for one entry, as in the Tauri app. */
const FREE_NAME_TRIES = 1000

/** The visible name of a staging directory whose source is unknown (Tauri's `UNKNOWN_SOURCE`). */
const UNKNOWN_SOURCE = 'Moved folder'

/** The ids of the moves running in this process, which a vault open leaves alone. */
const runningMoves = new Set<string>()

/** `/`-separated names only: no empty, `.` or `..` name, so nothing absolute either. */
const VaultRelativePath = z
  .string()
  .refine((p) =>
    p.split('/').every((name) => !['', '.', '..'].includes(name) && !name.includes('\\'))
  )

/**
 * A move going entry by entry, recorded in `.memry/moves/<id>.json` until it
 * ends, as `/`-separated vault-relative paths. This is the Tauri app's shipped
 * vault format (`crates/memry-desktop/src/vault/move_journal.rs`), written
 * byte for byte as its serde output, `{"version":1,"from":…,"staging":…}`, so
 * a move either app left half done is put back by whichever opens the vault
 * next. Tauri adds `shown` (the visible folder a show moves into, written
 * before anything moves there) and leaves `from` out of a record that only
 * shows a staging directory; both read here.
 */
const FolderMoveRecordSchema = z.object({
  version: z.number(),
  from: VaultRelativePath.optional(),
  staging: VaultRelativePath,
  shown: VaultRelativePath.optional()
})
type FolderMoveRecord = z.infer<typeof FolderMoveRecordSchema>

function moveRecordDir(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'moves')
}

async function removeMoveRecord(recordPath: string): Promise<void> {
  try {
    await rm(recordPath, { force: true })
  } catch (error) {
    // A record left behind finds its staging directory gone at the next open,
    // which then removes it.
    logger.warn(`Could not remove a folder move record: ${errnoCode(error) ?? 'unknown'}`)
  }
}

/**
 * Move the vault folder `from` to `to` (vault-relative), where `to` does not
 * exist yet.
 *
 * On Windows the vault watcher holds an open handle on every directory it
 * watches, and Windows refuses to rename a directory while anything beneath it
 * is open. A folder with at least one subfolder therefore fails `EPERM` on
 * every attempt, and retrying cannot help because the watcher never lets go
 * (#2206). A folder with no subfolder still renames, which is why only some
 * folders could be dragged.
 *
 * When the plain rename is refused that way, the tree is moved entry by entry
 * instead: a subfolder that renames is moved whole, one that does not is
 * recreated and its entries moved into it, and each emptied source directory
 * is removed. The entries go into a dot-named staging directory beside `to`,
 * which the watcher ignores and so holds nothing in, and the staging directory
 * is renamed to `to` last. The watcher then sees the moved folder appear
 * complete, the same way it sees a plain rename, so its unlink/add rename
 * detection keeps each note's identity.
 *
 * All or nothing: a step that fails undoes every step before it and the
 * original error is thrown, so a failed move never leaves a folder split in two.
 * When an undo step fails too, or the app quits mid-move, the entries already
 * moved stay in the staging directory, hidden from the watcher, while the rows
 * still name `from`. The move's record keeps `from` app-owned, so no unlink
 * under it becomes a delete, and the next open puts the entries back
 * (`recoverStrandedFolderMoves`).
 */
export async function moveDirectory(vaultPath: string, from: string, to: string): Promise<void> {
  const fromAbs = path.join(vaultPath, from)
  const toAbs = path.join(vaultPath, to)
  const relative = (abs: string): string => path.relative(vaultPath, abs).split(path.sep).join('/')
  try {
    await rename(fromAbs, toAbs)
    return
  } catch (error) {
    // An existing destination would be merged into by the entry-wise move;
    // leave that refusal to the caller exactly as the plain rename gave it.
    // A case-only rename (`journal` -> `Journal`) names the source itself on a
    // case-insensitive filesystem, so `to` "existing" is not a merge.
    if (!isLockedTreeError(error) || (existsSync(toAbs) && !isCaseOnlyRename(from, to))) {
      throw error
    }
  }

  const id = randomBytes(6).toString('hex')
  const stagingAbs = path.join(path.dirname(toAbs), `${STAGING_PREFIX}${id}`)
  const recordPath = recordPathOf(vaultPath, id)
  const record = { version: 1, from: relative(fromAbs), staging: relative(stagingAbs) }
  runningMoves.add(id)
  try {
    // Before the staging directory exists, so no crash leaves one unrecorded.
    await atomicWrite(recordPath, JSON.stringify(record))
    const undo: UndoStep[] = []
    try {
      await moveEntries(fromAbs, stagingAbs, undo)
      await withTransientFsRetry(() => rename(stagingAbs, toAbs), 'moveDirectory')
    } catch (error) {
      if (await runUndo(undo)) await removeMoveRecord(recordPath)
      else holdStrandedFolder(record.from)
      throw error
    }
    await removeMoveRecord(recordPath)
  } finally {
    runningMoves.delete(id)
  }
}

/**
 * Vault open, before the removal replay: finish each move a crash or a failed
 * undo left recorded, in the one direction its state allows.
 *
 * - Its staging directory is there: the move never reached its last step, the
 *   rename of the staging directory to `to`, and the rows still name `from`.
 *   It rolls back: every staged entry goes back into `from`, merging into a
 *   subfolder the move had split, so no folder stays in two places. Nothing is
 *   replaced: a note whose name was taken meanwhile comes back beside it as a
 *   conflict copy, and whatever is at `to` is left alone. A record has no
 *   `to`, so finishing the move forward would be a guess. What still cannot go
 *   back moves to a visible `<from name> (incomplete move)` beside the staging
 *   directory (the record's `shown` when a show was cut short), so no file
 *   stays hidden. A record with no `from` only shows its staging directory.
 * - Its staging directory is gone: the move ended (its folder is at `to`, and
 *   the replay re-keys each row to its moved file, rolling forward) or was
 *   fully undone. Only the record goes.
 *
 * Only a staging directory that not even the visible rename could empty keeps
 * its record, and its source app-owned for this session so none of its notes'
 * removals syncs as a delete, for the next open to try again. A newer
 * version's record stays for the app that wrote it and keeps its source held.
 * Then every `.memry-move-<id>` directory no usable record names (a
 * pre-journal build's, or its record's unusable) is renamed to a visible
 * `Moved folder (incomplete move)` beside it, never deleted, as the Tauri
 * sweep does: hidden, the replay would take its notes for deletes. An
 * unusable record goes once no staging directory of its id is left hidden.
 */
export async function recoverStrandedFolderMoves(vaultPath: string): Promise<void> {
  clearStrandedFolders()
  // The sweep runs in the background index build, which a folder rename does
  // not wait for, so a move can start at any await below. The invariant: the
  // sweep only shows or puts back a staging dir no live move owns, and never
  // replaces a file. `runningMoves` is therefore read live at every decision,
  // never from a snapshot, and every put-back step refuses an existing target.
  const claimed = new Set<string>()
  const owned = (id: string): boolean => claimed.has(id) || runningMoves.has(id)
  const unusable = new Map<string, string>()
  // Ids whose record is on disk but no build of this version can put back.
  const unreadable = new Set<string>()
  const recordDir = moveRecordDir(vaultPath)
  const names = existsSync(recordDir) ? await readdir(recordDir) : []

  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    if (!MOVE_ID.test(id) || runningMoves.has(id)) continue
    const recordPath = path.join(recordDir, name)
    let record: FolderMoveRecord | null = null
    try {
      record = await readMoveRecord(recordPath)
      if (record?.version !== undefined && record.version !== 1) {
        logger.error(`Leaving a version ${record.version} folder move record`)
        unreadable.add(id)
        if (record.from !== undefined) holdStrandedFolder(record.from)
      } else if (!record || !(await isOwnMove(vaultPath, id, record))) {
        logger.error('Showing the folder of a folder move record this build cannot use')
        unusable.set(id, recordPath)
        unreadable.add(id)
      } else if (!runningMoves.has(id)) {
        claimed.add(id)
        const stagingAbs = path.join(vaultPath, record.staging)
        const fromAbs = record.from === undefined ? null : path.join(vaultPath, record.from)
        if (existsSync(stagingAbs)) {
          if (fromAbs) {
            await mkdir(path.dirname(fromAbs), { recursive: true })
            await putBack(stagingAbs, fromAbs)
          }
          const shown = record.shown === undefined ? null : path.join(vaultPath, record.shown)
          await showStaged(stagingAbs, fromAbs ? path.basename(fromAbs) : UNKNOWN_SOURCE, shown)
        }
        if (!existsSync(stagingAbs)) await removeMoveRecord(recordPath)
        else if (record.from !== undefined) holdStrandedFolder(record.from)
      }
    } catch (error) {
      logger.error(`Could not put back a failed folder move: ${errnoCode(error) ?? 'unknown'}`)
      if (record?.from !== undefined) holdStrandedFolder(record.from)
    }
  }

  const exclude = readVaultConfig(vaultPath).excludePatterns
  const hidden = new Set<string>()
  for (const stagingAbs of await findStagingDirs(vaultPath, exclude)) {
    const id = path.basename(stagingAbs).slice(STAGING_PREFIX.length)
    // A record on disk that this build can use puts its staging directory
    // back at the next open: one the loop kept, one it skipped while its move
    // ran and that failed since, or one written since the loop read the journal.
    const recorded = !unreadable.has(id) && existsSync(recordPathOf(vaultPath, id))
    if (!owned(id) && !recorded) {
      logger.warn('Showing a folder move staging directory no usable record names')
      await showStaged(stagingAbs, UNKNOWN_SOURCE, null)
    }
    if (existsSync(stagingAbs)) hidden.add(id)
  }
  for (const [id, recordPath] of unusable) {
    if (!hidden.has(id)) await removeMoveRecord(recordPath)
  }
}

function recordPathOf(vaultPath: string, id: string): string {
  return path.join(moveRecordDir(vaultPath), `${id}.json`)
}

/**
 * The record at `recordPath` when it is one: a regular file, never followed
 * through a link or opened as a FIFO, of at most `RECORD_MAX_BYTES`. The
 * checks run on the opened file, so nothing swapped in after them is read:
 * `O_NOFOLLOW` refuses a link where the platform has it, `O_NONBLOCK` keeps a
 * FIFO from blocking, and the path must still name the file that was opened
 * (Windows has no `O_NOFOLLOW`).
 */
async function readMoveRecord(recordPath: string): Promise<FolderMoveRecord | null> {
  let handle: FileHandle
  try {
    // The mode applies only to a create, which these flags never ask for;
    // it tells CodeQL's insecure-temporary-file check the same.
    handle = await open(
      recordPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      0o600
    )
  } catch (error) {
    if (errnoCode(error) === 'ELOOP') return null // a link
    throw error
  }
  try {
    const stat = await handle.stat({ bigint: true })
    const named = await lstat(recordPath, { bigint: true })
    if (!stat.isFile() || !named.isFile() || named.ino !== stat.ino || named.dev !== stat.dev) {
      return null
    }
    const bytes = Buffer.alloc(RECORD_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > RECORD_MAX_BYTES) return null
    return parseMoveRecord(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle.close()
  }
}

/**
 * Every `.memry-move-<id>` directory in the vault, outside dot folders, links
 * and folders named exactly as an exclude pattern, as the Tauri open's walk.
 */
async function findStagingDirs(dir: string, exclude: string[]): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    logger.warn(
      `Could not look for folder move staging directories: ${errnoCode(error) ?? 'unknown'}`
    )
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const abs = path.join(dir, entry.name)
    if (entry.name.startsWith(STAGING_PREFIX)) {
      if (MOVE_ID.test(entry.name.slice(STAGING_PREFIX.length))) found.push(abs)
    } else if (!entry.name.startsWith('.') && !exclude.includes(entry.name)) {
      found.push(...(await findStagingDirs(abs, exclude)))
    }
  }
  return found
}

/** `rel` is `folder` or inside it, in any letter case. */
function within(rel: string, folder: string): boolean {
  return `${rel.toLowerCase()}/`.startsWith(`${folder.toLowerCase()}/`)
}

/**
 * The checks the Tauri sweep makes before it puts anything back: the staging
 * directory is the record's own (`.memry-move-<its id>`), the source is in
 * neither it nor `.memry` (in any letter case), and no path leads out of the
 * vault, through a link either. `shown` must also sit beside the staging
 * directory, where a show always puts it.
 */
async function isOwnMove(
  vaultPath: string,
  id: string,
  { from, staging, shown }: FolderMoveRecord
): Promise<boolean> {
  if (path.posix.basename(staging) !== `${STAGING_PREFIX}${id}`) return false
  if (from !== undefined && (within(from, staging) || within(from, '.memry'))) return false
  if (shown !== undefined && path.posix.dirname(shown) !== path.posix.dirname(staging)) {
    return false
  }
  for (const rel of [from, staging, shown]) {
    if (rel !== undefined && (await resolveVaultFile(vaultPath, rel)).kind === 'outside') {
      return false
    }
  }
  return true
}

function parseMoveRecord(text: string): FolderMoveRecord | null {
  try {
    const parsed = FolderMoveRecordSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    // Not JSON: left in place like a record the schema refuses.
    return null
  }
}

async function isTaken(abs: string): Promise<boolean> {
  try {
    await lstat(abs)
    return true
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw error
  }
}

/** The first free `name` from `candidates` beside `taken`, or null. */
async function freeName(taken: string, candidate: (n: number) => string): Promise<string | null> {
  for (let n = 1; n <= FREE_NAME_TRIES; n++) {
    const abs = path.join(path.dirname(taken), candidate(n))
    if (!(await isTaken(abs))) return abs
  }
  return null
}

/**
 * The Tauri put-back's names for `taken`: itself, then `<name> (conflict
 * copy)<ext>`, `(conflict copy 2)` and on. A directory's name keeps its dots.
 */
function* targetNames(taken: string, isDirectory: boolean): Generator<string> {
  yield taken
  const fileName = path.basename(taken)
  const dot = isDirectory ? -1 : fileName.lastIndexOf('.')
  const [name, ext] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, '']
  for (let n = 1; n <= FREE_NAME_TRIES; n++) {
    yield path.join(path.dirname(taken), `${name} (conflict copy${n === 1 ? '' : ` ${n}`})${ext}`)
  }
}

/** Logs a put-back step that failed; what it would have moved stays staged. */
async function tryStep(step: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTransientFsRetry(step, 'moveDirectory')
    return true
  } catch (error) {
    // Only the errno — never the path, which is note-derived.
    logger.error(`Could not put back a folder move entry: ${errnoCode(error) ?? 'unknown'}`)
    return false
  }
}

/** A rename onto a name that is there failed instead of replacing it. */
const TAKEN_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR'])

/** The hidden name beside a put-back target that a copy is made under first. */
const PUT_BACK_TEMP = '.memry-put-back'

function nameTakenError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
}

/**
 * Creates `target` from the file `staged` only while nothing is there, as
 * Tauri's `rename_no_replace`: Node has no exclusive rename, but a hard link
 * fails `EEXIST` on a name taken since the look. A volume with no hard links
 * (FAT, some network mounts) gets a copy, made under a hidden name first so
 * no crash leaves a half copy at `target`; the look before its rename is the
 * one window left there, as for a link.
 */
async function placeFile(staged: string, target: string): Promise<void> {
  try {
    await link(staged, target)
    return
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') throw error
  }
  if (await isTaken(target)) throw nameTakenError()
  const temp = path.join(path.dirname(target), PUT_BACK_TEMP)
  // A crash's leftover copy, whole or not.
  await rm(temp, { force: true })
  await copyFile(staged, temp, constants.COPYFILE_EXCL)
  if (await isTaken(target)) {
    await rm(temp, { force: true })
    throw nameTakenError()
  }
  await rename(temp, target)
}

/**
 * `target` holds the bytes of the file `staged`: its other hard link, or a
 * whole copy of it. A put-back cut short between placing `target` and
 * unlinking `staged` leaves exactly that.
 */
async function holdsSameBytes(staged: string, target: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    lstat(staged, { bigint: true }).catch(() => null),
    lstat(target, { bigint: true }).catch(() => null)
  ])
  if (!a?.isFile() || !b?.isFile() || a.size !== b.size) return false
  if (a.dev === b.dev && a.ino === b.ino) return true
  const [ha, hb] = [await open(staged, 'r'), await open(target, 'r').catch(() => null)]
  try {
    if (!hb) return false
    const [ba, bb] = [Buffer.alloc(64 * 1024), Buffer.alloc(64 * 1024)]
    for (let at = 0; ; at += ba.length) {
      const [{ bytesRead: na }, { bytesRead: nb }] = await Promise.all([
        ha.read(ba, 0, ba.length, at),
        hb.read(bb, 0, bb.length, at)
      ])
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false
      if (na === 0) return true
    }
  } finally {
    await ha.close()
    await hb?.close()
  }
}

/**
 * `staged` and `target` hold the same bytes: keep only `target`, or, when
 * `staged` cannot be unlinked, only `staged`, so a show never makes it a
 * second visible copy.
 */
async function keepOne(staged: string, target: string): Promise<void> {
  if (await tryStep(() => unlink(staged))) return
  if (await holdsSameBytes(staged, target)) await tryStep(() => unlink(target))
}

/**
 * Move the tree at `staged` back to `source`, merging into a directory that is
 * there, as the Tauri put-back does. Nothing is ever replaced, even by a file
 * that lands mid-way: a file goes back by an exclusive create, and an entry
 * whose name is taken comes back beside it at the first conflict name that
 * the create gets. A step that fails is logged and the rest still goes back;
 * what failed stays in `staged`.
 *
 * Invariant: every step is re-runnable; a crash between any two steps
 * reopens to exactly one visible copy. A file is placed (link, or copy to a
 * hidden name then rename) before its staged name is unlinked, so a crash in
 * between leaves `target` holding the staged bytes: the next run finds that
 * at the name it tries and only unlinks the staged one, never taking a
 * conflict name for it.
 */
async function putBack(staged: string, source: string): Promise<void> {
  const stat = await lstat(staged).catch(() => null)
  if (!stat) return // gone from the staging directory: nothing to put back
  const isDirectory = stat.isDirectory()
  if (isDirectory || stat.isSymbolicLink()) {
    // A directory rename refuses a file or a non-empty directory at the
    // target, so it replaces at most an empty directory: never a file. A link
    // has no exclusive create that keeps it a link: the look before its
    // rename is the one window left, as on a Tauri volume with no exclusive
    // rename.
    if (!(await isTaken(source))) {
      try {
        await withTransientFsRetry(() => rename(staged, source), 'moveDirectory')
        return
      } catch (error) {
        const code = errnoCode(error) ?? ''
        // A directory Windows holds goes back entry by entry.
        if (!TAKEN_CODES.has(code) && !(isDirectory && isLockedTreeError(error))) {
          logger.error(`Could not put back a folder move entry: ${code || 'unknown'}`)
          return
        }
      }
    }
  }
  for (const target of targetNames(source, isDirectory)) {
    try {
      if (!isDirectory) {
        if (stat.isSymbolicLink()) {
          if (await isTaken(target)) continue
          await withTransientFsRetry(() => rename(staged, target), 'moveDirectory')
        } else if (await holdsSameBytes(staged, target)) {
          await keepOne(staged, target)
        } else {
          await withTransientFsRetry(() => placeFile(staged, target), 'moveDirectory')
          await keepOne(staged, target)
        }
        return
      }
      try {
        await withTransientFsRetry(() => mkdir(target), 'moveDirectory')
      } catch (error) {
        // Merge only into a directory at the entry's own name.
        const merge = target === source && (await lstat(target).catch(() => null))?.isDirectory()
        if (errnoCode(error) !== 'EEXIST' || !merge) throw error
      }
      for (const name of await readdir(staged)) {
        await putBack(path.join(staged, name), path.join(target, name))
      }
      await tryStep(() => rmdir(staged))
      return
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') continue
      logger.error(`Could not put back a folder move entry: ${errnoCode(error) ?? 'unknown'}`)
      return
    }
  }
  logger.error('Could not put back a folder move entry: no free conflict name')
}

/**
 * Move what is left in the staging directory into `shown` when a show that
 * was cut short named it and it is a directory, or else into the first free
 * visible `<name> (incomplete move)`, then `(incomplete move 2)` and on,
 * beside it: Tauri's names, so the user finds the files.
 */
async function showStaged(stagingAbs: string, name: string, shown: string | null): Promise<void> {
  if (!existsSync(stagingAbs)) return
  const reuse = shown && (await lstat(shown).catch(() => null))?.isDirectory()
  const visible = reuse
    ? shown
    : await freeName(stagingAbs, (n) => `${name} (incomplete move${n === 1 ? '' : ` ${n}`})`)
  if (visible) await putBack(stagingAbs, visible)
  if (existsSync(stagingAbs)) {
    logger.error('A failed folder move left files in its hidden staging directory')
  }
}

async function moveEntries(from: string, to: string, undo: UndoStep[]): Promise<void> {
  await mkdir(to)
  undo.push(() => rmdir(to))

  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)

    if (entry.isDirectory()) {
      try {
        await rename(source, target)
        undo.push(() => rename(target, source))
        continue
      } catch (error) {
        if (!isLockedTreeError(error)) throw error
      }
      await moveEntries(source, target, undo)
      continue
    }

    await withTransientFsRetry(() => rename(source, target), 'moveDirectory')
    undo.push(() => rename(target, source))
  }

  // Non-recursive on purpose: a file that lands in the source mid-move makes
  // this fail and the move roll back, instead of being deleted with the folder.
  await withTransientFsRetry(() => rmdir(from), 'moveDirectory')
  undo.push(() => mkdir(from))
}

/** Whether every step was undone. */
async function runUndo(undo: UndoStep[]): Promise<boolean> {
  let undone = true
  for (const step of undo.toReversed()) {
    try {
      await step()
    } catch (error) {
      undone = false
      // Only the errno — never the path, which is note-derived.
      logger.error(
        `Could not undo a step of a failed folder move: ${errnoCode(error) ?? 'unknown'}`
      )
    }
  }
  return undone
}
