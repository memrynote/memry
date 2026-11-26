/**
 * Folders the app itself is moving or deleting.
 *
 * @module vault/app-folder-changes
 */

/**
 * The watcher's unlink and unlinkDir events for such a folder arrive while the
 * app is still moving notes, before it re-keys or deletes the rows, so the
 * watcher must leave these paths to the app instead of tombstoning their rows
 * as an outside delete (#2850, #5695).
 */
const appFolderChanges = new Map<string, number>()
const runningChanges = new Set<Promise<unknown>>()

/**
 * Sources of folder moves that failed with entries left in their staging
 * directory (`moveDirectory`). Their notes' files are hidden there, not gone,
 * so the folders stay the app's until a vault open puts the entries back.
 */
const strandedFolders = new Set<string>()

function covers(owned: string, folderPath: string): boolean {
  return folderPath === owned || folderPath.startsWith(`${owned}/`)
}

function isRunningChange(folderPath: string): boolean {
  for (const owned of appFolderChanges.keys()) if (covers(owned, folderPath)) return true
  return false
}

export function isAppFolderChange(folderPath: string): boolean {
  if (isRunningChange(folderPath)) return true
  for (const owned of strandedFolders) if (covers(owned, folderPath)) return true
  return false
}

/**
 * Settles once no running app folder change covers `folderPath`, and says
 * whether one did. A stranded folder is not waited for: it stays held until a
 * vault open puts it back.
 */
export async function settleAppFolderChanges(folderPath: string): Promise<boolean> {
  if (!isRunningChange(folderPath)) return false
  while (isRunningChange(folderPath)) await Promise.allSettled(runningChanges)
  return true
}

/** Marks `folderPaths` as app-owned until `change` settles. */
export async function withAppFolderChange<T>(
  folderPaths: string[],
  change: () => Promise<T>
): Promise<T> {
  for (const p of folderPaths) appFolderChanges.set(p, (appFolderChanges.get(p) ?? 0) + 1)
  const running = (async () => change())()
  runningChanges.add(running)
  try {
    return await running
  } finally {
    runningChanges.delete(running)
    for (const p of folderPaths) {
      const count = (appFolderChanges.get(p) ?? 1) - 1
      if (count > 0) appFolderChanges.set(p, count)
      else appFolderChanges.delete(p)
    }
  }
}

/** Keeps `folderPath` app-owned until the stranded folders are cleared. */
export function holdStrandedFolder(folderPath: string): void {
  strandedFolders.add(folderPath)
}

/** Forgets the stranded folders, as a vault open starts over with its own. */
export function clearStrandedFolders(): void {
  strandedFolders.clear()
}
