import path from 'path'

/** What a requested folder path names, read the way note rows name folders. */
export type VaultFolder = { kind: 'folder'; path: string } | { kind: 'root' } | { kind: 'outside' }

/**
 * `folderPath` as note rows name the folder: `/` separators, no `.` or empty
 * segments, no trailing `/`, so `./Work/` and `Work\` are `Work` (#5642).
 * `root` for the vault itself (`''`, `.`, `/`) and `outside` for a path that
 * leaves it (`..`, an absolute path), which a recursive delete must never
 * reach (#5653).
 */
export function parseVaultFolder(folderPath: string): VaultFolder {
  const folder = path.posix.normalize(folderPath.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (folder === '' || folder === '.') return { kind: 'root' }
  if (folder === '..' || folder.startsWith('../') || path.win32.isAbsolute(folder)) {
    return { kind: 'outside' }
  }
  return { kind: 'folder', path: folder }
}

/** The folder `folderPath` names inside the vault, or null for the vault itself or outside it. */
export function vaultFolderPath(folderPath: string): string | null {
  const folder = parseVaultFolder(folderPath)
  return folder.kind === 'folder' ? folder.path : null
}

/**
 * Whether this device reads `folder` as another folder. Windows drops a dot or
 * a space at the end of a name, so there a peer's `Work.` is the folder `Work`.
 */
export function windowsTrimsFolderName(folder: string): boolean {
  return process.platform === 'win32' && folder.split('/').some((segment) => /[. ]$/.test(segment))
}
