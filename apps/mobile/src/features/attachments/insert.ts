import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import type { AttachmentTransfer } from '@/adapters/attachments'
import { createLogger } from '@/lib/logger'
import { generateId, updateNote, type NoteOpsContext } from '@/features/notes/note-ops'

const log = createLogger('AttachmentInsert')

/**
 * Insert an image or file into a note from the phone (T073).
 *
 * The order matters and mirrors desktop's: upload FIRST, then record the
 * reference on the note, then insert the block. A reference written before the
 * blob exists is a broken image on every other device until the upload happens
 * to succeed — and the note push that carries `attachmentReferences` is what
 * makes peers fetch at all, so the two must land together.
 */

export interface PickedFile {
  name: string
  mimeType: string
  uri: string
}

export async function pickImage(): Promise<PickedFile | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) return null

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    // The vault stores what the user picked. Re-encoding here would make the
    // desktop copy and the phone copy different files with different hashes.
    quality: 1,
    exif: false
  })
  if (result.canceled || result.assets.length === 0) return null

  const asset = result.assets[0]
  return {
    name: asset.fileName ?? `image-${Date.now()}.jpg`,
    mimeType: asset.mimeType ?? 'image/jpeg',
    uri: asset.uri
  }
}

export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
  if (result.canceled || result.assets.length === 0) return null

  const asset = result.assets[0]
  return {
    name: asset.name,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    uri: asset.uri
  }
}

export interface InsertResult {
  attachmentId: string
  /** The reference the note body carries; desktop resolves the same string. */
  ref: string
  filename: string
  mimeType: string
}

export async function insertAttachment(
  ctx: NoteOpsContext,
  transfer: AttachmentTransfer,
  noteId: string,
  picked: PickedFile
): Promise<InsertResult | null> {
  const file = new File(picked.uri)
  if (!file.exists) {
    log.warn('Picked file no longer exists', { uri: picked.uri })
    return null
  }

  const bytes = file.bytesSync()
  const attachmentId = generateId()
  const filename = sanitizeFilename(picked.name)

  try {
    await transfer.upload(attachmentId, filename, picked.mimeType, bytes)
  } catch (err) {
    log.error('Attachment upload failed; nothing was written to the note', {
      noteId,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }

  // The reference the other shells resolve: `attachments/<noteId>/<filename>`,
  // matched by basename against the manifest filename (migration 0003).
  const ref = `attachments/${noteId}/${filename}`

  await updateNote(ctx, noteId, (payload) => {
    const existing = Array.isArray(payload.attachmentReferences)
      ? (payload.attachmentReferences as string[])
      : []
    // Union, never replace: a note edited on two devices would otherwise lose
    // the other one's embeds on the next merge.
    payload.attachmentReferences = existing.includes(attachmentId)
      ? existing
      : [...existing, attachmentId]
  })

  return { attachmentId, ref, filename, mimeType: picked.mimeType }
}

/** Characters that are illegal in a filename on one of the platforms we ship. */
const UNSAFE_FILENAME_CHARS = new RegExp('[\\u0000-\\u001f<>:"|?*\\\\/]', 'g')

/**
 * The same rule desktop applies before writing a manifest filename to disk. The
 * name is attacker-influenced: it rides inside a signed manifest, but the
 * signer may be another of the user's own devices running anything.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, '_').trim()
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file'
}
