import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import type {
  LocalVault,
  VaultDirEntry,
  VaultFileSystemAdapter
} from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 6 over `node:fs`.
 *
 * The ROOT half (where vaults live) is platform/app-state bound — desktop
 * resolves it from the store and the account vault list — so it is injected as
 * a `VaultRootSource`. The CONTENT half is pure `node:fs` and is the part the
 * conformance suite exercises for real: atomic writes that create their own
 * parents, absence as `null`/`false`, non-recursive listing, and the
 * ignore-list-guarded empty-directory removal.
 */
export interface VaultRootSource {
  resolveVaultRoot(vaultId: string): Promise<string>
  listLocalVaults(): Promise<LocalVault[]>
  provision(vaultId: string): Promise<string>
}

/** Filesystem-safe directory name — same idea as the CRDT store's dir naming. */
const safeDirName = (id: string): string => {
  const normalized = id.trim()
  if (/^[A-Za-z0-9._-]+$/.test(normalized)) return normalized
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

/**
 * A self-contained root source keeping one vault per directory under
 * `baseDir`. Used by the conformance harness (over a temp dir) and by any
 * future flow that owns its own vault base; production wiring substitutes the
 * store-backed resolution.
 */
export function directoryVaultRoots(baseDir: string): VaultRootSource {
  const rootFor = (vaultId: string): string => path.join(baseDir, safeDirName(vaultId))
  return {
    async resolveVaultRoot(vaultId) {
      return rootFor(vaultId)
    },
    async listLocalVaults() {
      let entries
      try {
        entries = await fsp.readdir(baseDir, { withFileTypes: true })
      } catch {
        return []
      }
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ vaultId: entry.name, root: path.join(baseDir, entry.name) }))
    },
    async provision(vaultId) {
      const root = rootFor(vaultId)
      await fsp.mkdir(root, { recursive: true })
      return root
    }
  }
}

/** Reject absolute paths and traversal — relative, `/`-separated only. */
const assertRelPath = (relPath: string): string[] => {
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.includes('\\')) {
    throw new Error(`vault path must be relative with '/' separators: ${relPath}`)
  }
  const segments = relPath.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`vault path must not traverse upward: ${relPath}`)
  }
  return segments
}

const isEnoent = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'

export class DesktopVaultFileSystem implements VaultFileSystemAdapter {
  constructor(private readonly roots: VaultRootSource) {}

  resolveVaultRoot(vaultId: string): Promise<string> {
    return this.roots.resolveVaultRoot(vaultId)
  }

  listLocalVaults(): Promise<LocalVault[]> {
    return this.roots.listLocalVaults()
  }

  provision(vaultId: string): Promise<string> {
    return this.roots.provision(vaultId)
  }

  private async abs(vaultId: string, relPath: string): Promise<string> {
    const segments = assertRelPath(relPath)
    const root = await this.roots.resolveVaultRoot(vaultId)
    return path.join(root, ...segments)
  }

  async readFile(vaultId: string, relPath: string): Promise<string | null> {
    try {
      return await fsp.readFile(await this.abs(vaultId, relPath), 'utf8')
    } catch (err) {
      if (isEnoent(err)) return null
      throw err
    }
  }

  async readBytes(vaultId: string, relPath: string): Promise<Uint8Array | null> {
    try {
      const buffer = await fsp.readFile(await this.abs(vaultId, relPath))
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (err) {
      if (isEnoent(err)) return null
      throw err
    }
  }

  private async atomicWrite(target: string, data: string | Uint8Array): Promise<void> {
    const dir = path.dirname(target)
    await fsp.mkdir(dir, { recursive: true })
    const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fsp.writeFile(tempPath, data)
      await fsp.rename(tempPath, target)
    } catch (err) {
      await fsp.rm(tempPath, { force: true })
      throw err
    }
  }

  async writeFile(vaultId: string, relPath: string, content: string): Promise<void> {
    await this.atomicWrite(await this.abs(vaultId, relPath), content)
  }

  async writeBytes(vaultId: string, relPath: string, bytes: Uint8Array): Promise<void> {
    await this.atomicWrite(await this.abs(vaultId, relPath), bytes)
  }

  async exists(vaultId: string, relPath: string): Promise<boolean> {
    try {
      await fsp.access(await this.abs(vaultId, relPath))
      return true
    } catch {
      return false
    }
  }

  async remove(vaultId: string, relPath: string): Promise<boolean> {
    try {
      await fsp.unlink(await this.abs(vaultId, relPath))
      return true
    } catch (err) {
      if (isEnoent(err)) return false
      throw err
    }
  }

  async rename(vaultId: string, fromRelPath: string, toRelPath: string): Promise<void> {
    const from = await this.abs(vaultId, fromRelPath)
    const to = await this.abs(vaultId, toRelPath)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rename(from, to)
  }

  async list(vaultId: string, relDir: string): Promise<VaultDirEntry[]> {
    const segments = assertRelPath(relDir)
    const root = await this.roots.resolveVaultRoot(vaultId)
    const absDir = path.join(root, ...segments)
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch (err) {
      if (isEnoent(err)) return []
      throw err
    }
    const prefix = segments.join('/')
    return entries.map((entry) => ({
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      kind: entry.isDirectory() ? ('directory' as const) : ('file' as const)
    }))
  }

  async removeDirIfEmpty(
    vaultId: string,
    relDir: string,
    ignoring: ReadonlyArray<string>
  ): Promise<boolean> {
    const segments = assertRelPath(relDir)
    const root = await this.roots.resolveVaultRoot(vaultId)
    const absDir = path.join(root, ...segments)
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch (err) {
      if (isEnoent(err)) return false
      throw err
    }
    const ignore = new Set(ignoring)
    // Anything not on the ignore list keeps the directory alive: a recursive
    // delete here would be a data-loss bug, so this refuses instead.
    if (entries.some((entry) => entry.isDirectory() || !ignore.has(entry.name))) return false
    for (const entry of entries) {
      await fsp.rm(path.join(absDir, entry.name), { force: true })
    }
    try {
      await fsp.rmdir(absDir)
    } catch (err) {
      if (isEnoent(err)) return false
      throw err
    }
    return true
  }
}
