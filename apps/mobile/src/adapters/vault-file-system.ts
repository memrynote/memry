import { Directory, File } from 'expo-file-system'
import type { LocalVault, VaultDirEntry, VaultFileSystemAdapter } from '@memry/sync-client/adapters'
import { vaultDir, vaultsRootDir } from '../db/index'

/**
 * Seam 6 on mobile: the vault lives in the app sandbox under
 * Documents/vaults/<vaultId>/files (same non-evictable tree as the vault DB;
 * NSFileProtection entitlement covers the sandbox). Contract behaviours match
 * desktop's `DesktopVaultFileSystem`: relative `/` paths only, atomic
 * temp+rename writes that create parents, absence resolves null/false/[],
 * no exposed mkdir, and removeDirIfEmpty never recurses.
 */

const FILES_SUBDIR = 'files'

function assertRelPath(relPath: string): string {
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.includes('\\')) {
    throw new Error(`vault paths are relative with '/' separators: ${relPath}`)
  }
  const segments = relPath.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..')) {
    throw new Error(`vault paths may not traverse upward: ${relPath}`)
  }
  return segments.join('/')
}

function filesRoot(vaultId: string): Directory {
  return new Directory(vaultDir(vaultId), FILES_SUBDIR)
}

function fileAt(vaultId: string, relPath: string): File {
  return new File(filesRoot(vaultId), ...assertRelPath(relPath).split('/'))
}

function dirAt(vaultId: string, relDir: string): Directory {
  const clean = assertRelPath(relDir)
  return clean === '' ? filesRoot(vaultId) : new Directory(filesRoot(vaultId), ...clean.split('/'))
}

function parentDirOf(vaultId: string, relPath: string): Directory {
  const clean = assertRelPath(relPath)
  const idx = clean.lastIndexOf('/')
  return idx === -1 ? filesRoot(vaultId) : dirAt(vaultId, clean.slice(0, idx))
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function atomicWrite(vaultId: string, relPath: string, content: string | Uint8Array): void {
  const parent = parentDirOf(vaultId, relPath)
  if (!parent.exists) parent.create({ intermediates: true })
  const target = fileAt(vaultId, relPath)
  const temp = new File(parent, `.${target.name}.${randomSuffix()}.tmp`)
  try {
    temp.write(content)
    if (target.exists) target.delete()
    temp.moveSync(target)
  } catch (err) {
    try {
      if (temp.exists) temp.delete()
    } catch {
      // best-effort tmp cleanup
    }
    throw err
  }
}

export function createMobileVaultFileSystem(): VaultFileSystemAdapter {
  return {
    async resolveVaultRoot(vaultId) {
      return filesRoot(vaultId).uri
    },

    async listLocalVaults(): Promise<LocalVault[]> {
      const root = vaultsRootDir()
      if (!root.exists) return []
      return root
        .list()
        .filter((entry): entry is Directory => entry instanceof Directory)
        .map((dir) => ({ vaultId: dir.name, root: new Directory(dir, FILES_SUBDIR).uri }))
    },

    async provision(vaultId) {
      // The new-device path must never dead-end: create the whole chain.
      const files = filesRoot(vaultId)
      if (!files.exists) files.create({ intermediates: true })
      return files.uri
    },

    async readFile(vaultId, relPath) {
      const file = fileAt(vaultId, relPath)
      if (!file.exists) return null
      return file.textSync()
    },

    async readBytes(vaultId, relPath) {
      const file = fileAt(vaultId, relPath)
      if (!file.exists) return null
      return file.bytesSync()
    },

    async writeFile(vaultId, relPath, content) {
      atomicWrite(vaultId, relPath, content)
    },

    async writeBytes(vaultId, relPath, bytes) {
      atomicWrite(vaultId, relPath, bytes)
    },

    async exists(vaultId, relPath) {
      return fileAt(vaultId, relPath).exists || dirAt(vaultId, relPath).exists
    },

    async remove(vaultId, relPath) {
      const file = fileAt(vaultId, relPath)
      if (!file.exists) return false
      file.delete()
      return true
    },

    async rename(vaultId, fromRelPath, toRelPath) {
      const from = fileAt(vaultId, fromRelPath)
      const destParent = parentDirOf(vaultId, toRelPath)
      if (!destParent.exists) destParent.create({ intermediates: true })
      const to = fileAt(vaultId, toRelPath)
      if (to.exists) to.delete()
      from.moveSync(to)
    },

    async list(vaultId, relDir): Promise<VaultDirEntry[]> {
      const dir = dirAt(vaultId, relDir)
      if (!dir.exists) return []
      const prefix = assertRelPath(relDir)
      return dir.list().map((entry) => ({
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        kind: entry instanceof Directory ? 'directory' : 'file'
      }))
    },

    async removeDirIfEmpty(vaultId, relDir, ignoring) {
      const dir = dirAt(vaultId, relDir)
      if (!dir.exists) return false
      const entries = dir.list()
      const hasSubdir = entries.some((e) => e instanceof Directory)
      const offList = entries.some((e) => !(e instanceof Directory) && !ignoring.includes(e.name))
      if (hasSubdir || offList) return false
      for (const entry of entries) {
        entry.delete()
      }
      dir.delete()
      return true
    }
  }
}
