/**
 * Move a vault directory, including one the vault watcher holds open.
 *
 * @module vault/move-directory
 */

import path from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rename, rm, rmdir } from 'fs/promises'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { atomicWrite, withTransientFsRetry } from './file-ops'
import { getMemryDir } from './init'
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
 * next. Tauri adds `shown` (a visible folder it put leftovers in) and leaves
 * `from` out of a record that only shows a staging directory; both read here.
 */
const FolderMoveRecordSchema = z.object({
  version: z.number(),
  from: VaultRelativePath.optional(),
  staging: VaultRelativePath
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
  const recordPath = path.join(moveRecordDir(vaultPath), `${id}.json`)
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
 *   replaced, and whatever is at `to` is left alone. A record has no `to`, so
 *   finishing the move forward would be a guess.
 * - Its staging directory is gone: the move ended (its folder is at `to`, and
 *   the replay re-keys each row to its moved file, rolling forward) or was
 *   fully undone. Only the record goes.
 *
 * A move that cannot be put back keeps its source app-owned for this session,
 * so none of its notes' removals syncs as a delete, and is tried again at the
 * next open. A record this build cannot act on stays for the app that wrote
 * it; a newer version's keeps its source held the same way.
 */
export async function recoverStrandedFolderMoves(vaultPath: string): Promise<void> {
  clearStrandedFolders()
  const recordDir = moveRecordDir(vaultPath)
  if (!existsSync(recordDir)) return

  for (const name of await readdir(recordDir)) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    if (!MOVE_ID.test(id) || runningMoves.has(id)) continue
    const recordPath = path.join(recordDir, name)
    let record: FolderMoveRecord | null = null
    try {
      record = parseMoveRecord(await readFile(recordPath, 'utf8'))
      if (!record) {
        logger.error('Leaving a folder move record this build cannot read')
      } else if (record.version !== 1) {
        logger.error(`Leaving a version ${record.version} folder move record`)
        if (record.from !== undefined) holdStrandedFolder(record.from)
      } else if (record.from === undefined || !(await isOwnMove(vaultPath, id, record))) {
        logger.error('Leaving a folder move record that names no source of its own')
      } else {
        const stagingAbs = path.join(vaultPath, record.staging)
        if (existsSync(stagingAbs)) await putBack(stagingAbs, path.join(vaultPath, record.from))
        await removeMoveRecord(recordPath)
      }
    } catch (error) {
      logger.error(`Could not put back a failed folder move: ${errnoCode(error) ?? 'unknown'}`)
      if (record?.from !== undefined) holdStrandedFolder(record.from)
    }
  }
}

/** `rel` is `folder` or inside it, in any letter case. */
function within(rel: string, folder: string): boolean {
  return `${rel.toLowerCase()}/`.startsWith(`${folder.toLowerCase()}/`)
}

/**
 * The checks the Tauri sweep makes before it puts anything back: the staging
 * directory is the record's own (`.memry-move-<its id>`), the source is in
 * neither it nor `.memry` (in any letter case), and no path leads out of the
 * vault, through a link either.
 */
async function isOwnMove(
  vaultPath: string,
  id: string,
  { from, staging }: FolderMoveRecord
): Promise<boolean> {
  if (from === undefined || path.posix.basename(staging) !== `${STAGING_PREFIX}${id}`) return false
  if (within(from, staging) || within(from, '.memry')) return false
  for (const rel of [from, staging]) {
    if ((await resolveVaultFile(vaultPath, rel)).kind === 'outside') return false
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

/**
 * Move every entry of `staged` back into `source`, merging into a directory
 * the move had split. An entry `source` already has again is left where it is,
 * so nothing is overwritten and the staging directory stays for the next try.
 */
async function putBack(staged: string, source: string): Promise<void> {
  await mkdir(source, { recursive: true })
  for (const entry of await readdir(staged, { withFileTypes: true })) {
    const from = path.join(staged, entry.name)
    const to = path.join(source, entry.name)
    if (!existsSync(to)) await withTransientFsRetry(() => rename(from, to), 'moveDirectory')
    else if (entry.isDirectory()) await putBack(from, to)
  }
  await withTransientFsRetry(() => rmdir(staged), 'moveDirectory')
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
