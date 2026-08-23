import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import type { AttachmentStoreAdapter } from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 5 — attachment bytes as files.
 *
 * Where those files live is app-state bound (the vault's files directory), so
 * the directory resolution is injected; the byte semantics — atomic writes,
 * `null` for absence, idempotent delete — are what this class owns and what
 * the conformance suite proves.
 */
const safeName = (id: string): string => {
  if (/^[A-Za-z0-9._-]+$/.test(id)) return id
  return createHash('sha256').update(id).digest('hex')
}

const isEnoent = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'

export class DesktopAttachmentStore implements AttachmentStoreAdapter {
  constructor(private readonly attachmentsDirFor: (vaultId: string) => Promise<string>) {}

  private async pathFor(vaultId: string, attachmentId: string): Promise<string> {
    const dir = await this.attachmentsDirFor(vaultId)
    return path.join(dir, safeName(attachmentId))
  }

  async writeBytes(
    vaultId: string,
    attachmentId: string,
    bytes: Uint8Array
  ): Promise<{ path: string }> {
    const target = await this.pathFor(vaultId, attachmentId)
    const dir = path.dirname(target)
    await fsp.mkdir(dir, { recursive: true })
    const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fsp.writeFile(tempPath, bytes)
      await fsp.rename(tempPath, target)
    } catch (err) {
      await fsp.rm(tempPath, { force: true })
      throw err
    }
    return { path: target }
  }

  async readBytes(vaultId: string, attachmentId: string): Promise<Uint8Array | null> {
    try {
      const buffer = await fsp.readFile(await this.pathFor(vaultId, attachmentId))
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (err) {
      if (isEnoent(err)) return null
      throw err
    }
  }

  async exists(vaultId: string, attachmentId: string): Promise<boolean> {
    try {
      await fsp.access(await this.pathFor(vaultId, attachmentId))
      return true
    } catch {
      return false
    }
  }

  async delete(vaultId: string, attachmentId: string): Promise<void> {
    try {
      await fsp.unlink(await this.pathFor(vaultId, attachmentId))
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
  }
}
