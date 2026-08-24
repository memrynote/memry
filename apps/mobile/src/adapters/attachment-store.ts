import { Directory, File } from 'expo-file-system'
import type { AttachmentStoreAdapter } from '@memry/sync-client/adapters'
import { genericHash, toHex } from '../crypto/libsodium'
import { vaultDir } from '../db/index'

/**
 * Seam 5 on mobile: attachment bytes are sandbox files under the vault
 * directory (never blobs in the DB — data-model store-of-record rule). The
 * NSFileProtection entitlement covers the sandbox. Lazy/Wi-Fi-only download
 * POLICY lives in the engine, not here.
 */

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

function safeName(attachmentId: string): string {
  if (SAFE_NAME.test(attachmentId)) return attachmentId
  return toHex(genericHash(32, new TextEncoder().encode(attachmentId)))
}

function attachmentsDir(vaultId: string): Directory {
  return new Directory(vaultDir(vaultId), 'attachments')
}

function attachmentFile(vaultId: string, attachmentId: string): File {
  return new File(attachmentsDir(vaultId), safeName(attachmentId))
}

export function createMobileAttachmentStore(): AttachmentStoreAdapter {
  return {
    async writeBytes(vaultId, attachmentId, bytes) {
      const dir = attachmentsDir(vaultId)
      if (!dir.exists) dir.create({ intermediates: true })
      const target = attachmentFile(vaultId, attachmentId)
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('')
      const temp = new File(dir, `.${target.name}.${suffix}.tmp`)
      try {
        temp.write(bytes)
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
      return { path: target.uri }
    },

    async readBytes(vaultId, attachmentId) {
      const file = attachmentFile(vaultId, attachmentId)
      if (!file.exists) return null
      return file.bytesSync()
    },

    async exists(vaultId, attachmentId) {
      return attachmentFile(vaultId, attachmentId).exists
    },

    async delete(vaultId, attachmentId) {
      const file = attachmentFile(vaultId, attachmentId)
      if (file.exists) file.delete()
    }
  }
}
