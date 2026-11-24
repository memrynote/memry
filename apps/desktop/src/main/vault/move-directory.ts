/**
 * Move a vault directory, including one the vault watcher holds open.
 *
 * @module vault/move-directory
 */

import path from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'fs/promises'
import { randomBytes } from 'crypto'
import { withTransientFsRetry } from './file-ops'
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

/**
 * Move the directory `from` to `to`, where `to` does not exist yet.
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
 *
 * A crash mid-move leaves the moved entries in the staging directory, which
 * no index walk sees, while their rows still name the old paths: the next
 * open would sync each note's delete. So the move records its staging
 * directory in the vault's `.memry/folder-moves` until it is gone, and
 * `recoverFolderMoves` finishes the move at the next open, before the removals
 * are replayed and pair each moved file with its row.
 */
export async function moveDirectory(from: string, to: string, vaultRoot: string): Promise<void> {
  try {
    await rename(from, to)
    return
  } catch (error) {
    // An existing destination would be merged into by the entry-wise move;
    // leave that refusal to the caller exactly as the plain rename gave it.
    // A case-only rename (`journal` -> `Journal`) names the source itself on a
    // case-insensitive filesystem, so `to` "existing" is not a merge.
    if (!isLockedTreeError(error) || (existsSync(to) && !isCaseOnlyRename(from, to))) throw error
  }

  const id = randomBytes(6).toString('hex')
  const staging = path.join(path.dirname(to), `.memry-move-${id}`)
  const journal = path.join(journalDir(vaultRoot), `${id}.json`)
  const relative = (p: string): string => path.relative(vaultRoot, p).split(path.sep).join('/')
  await mkdir(journalDir(vaultRoot), { recursive: true })
  await writeFile(journal, JSON.stringify({ staging: relative(staging), to: relative(to) }))
  const undo: UndoStep[] = []

  try {
    await moveEntries(from, staging, undo)
    await withTransientFsRetry(() => rename(staging, to), 'moveDirectory')
  } catch (error) {
    await runUndo(undo)
    throw error
  } finally {
    // Kept while an undo that failed leaves entries in the staging directory.
    if (!existsSync(staging)) await rm(journal, { force: true })
  }
}

function journalDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.memry', 'folder-moves')
}

/**
 * Vault open: finish each entry-wise move a crash interrupted. Its staging
 * directory becomes the moved folder, and what the move had not reached stays
 * in the old one, so no file is lost and the removal replay re-keys each
 * moved note's row instead of deleting it.
 */
export async function recoverFolderMoves(vaultRoot: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(journalDir(vaultRoot))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const journal = path.join(journalDir(vaultRoot), name)
    const move = parseJournal(await readFile(journal, 'utf8'), vaultRoot)
    if (!move) {
      logger.error('Could not read the record of an interrupted folder move')
      continue
    }
    const { staging, to } = move
    if (existsSync(staging)) {
      if (existsSync(to)) {
        logger.error('An interrupted folder move cannot finish: its destination exists')
        continue
      }
      await rename(staging, to)
      logger.warn('Finished a folder move a crash interrupted')
    }
    await rm(journal, { force: true })
  }
}

/** A move's absolute paths. Null unless its staging directory is a sibling of `to` in the vault. */
function parseJournal(text: string, vaultRoot: string): { staging: string; to: string } | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  if (!('staging' in value) || typeof value.staging !== 'string') return null
  if (!('to' in value) || typeof value.to !== 'string') return null
  const staging = path.resolve(vaultRoot, value.staging)
  const to = path.resolve(vaultRoot, value.to)
  const inVault = path.relative(vaultRoot, to)
  if (!inVault || inVault.startsWith('..') || path.isAbsolute(inVault)) return null
  if (path.dirname(staging) !== path.dirname(to)) return null
  return /^\.memry-move-[0-9a-f]{12}$/.test(path.basename(staging)) ? { staging, to } : null
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

async function runUndo(undo: UndoStep[]): Promise<void> {
  for (const step of undo.toReversed()) {
    try {
      await step()
    } catch (error) {
      // Only the errno — never the path, which is note-derived.
      logger.error(
        `Could not undo a step of a failed folder move: ${errnoCode(error) ?? 'unknown'}`
      )
    }
  }
}
