import path from 'path'

/** What a requested folder path names, read the way note rows name folders. */
export type VaultFolder =
  | { kind: 'folder'; path: string }
  | { kind: 'root' }
  | { kind: 'outside' }
  | { kind: 'windowsAlias' }

/**
 * `folderPath` as note rows name the folder: `/` separators, no `.` or empty
 * segments, no trailing `/`, so `./Work/` and `Work\` are `Work` (#5642).
 * `root` for the vault itself (`''`, `.`, `/`) and `outside` for a path that
 * leaves it (`..`, an absolute path), which a recursive delete must never
 * reach (#5653). On Windows a name ending in a dot or a space is a
 * `windowsAlias`: Windows drops them, so `Work.` there is the folder `Work`.
 */
export function parseVaultFolder(folderPath: string): VaultFolder {
  const folder = path.posix.normalize(folderPath.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (folder === '' || folder === '.') return { kind: 'root' }
  if (folder === '..' || folder.startsWith('../') || path.win32.isAbsolute(folder)) {
    return { kind: 'outside' }
  }
  if (process.platform === 'win32' && folder.split('/').some((segment) => /[. ]$/.test(segment))) {
    return { kind: 'windowsAlias' }
  }
  return { kind: 'folder', path: folder }
}

/** The folder `folderPath` names inside the vault, or null for any other {@link VaultFolder}. */
export function vaultFolderPath(folderPath: string): string | null {
  const folder = parseVaultFolder(folderPath)
  return folder.kind === 'folder' ? folder.path : null
}
