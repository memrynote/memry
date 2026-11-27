import { isBinaryNoteRow } from './file-types.ts'

/**
 * The vault folder that holds every note's attachments folder. Fixed, whatever
 * the vault config's `attachmentsFolder` says: older configs may carry another
 * value, and desktop and the CLI ignore it.
 */
export const ATTACHMENTS_DIR = 'attachments'

/**
 * Whether a vault-relative path is the vault root's attachments folder or
 * inside it. No note lives there: the indexer and the watcher skip it. Only
 * the root folder is the app's; a nested `attachments` folder holds the user's
 * notes (#3161). Either separator: on Windows chokidar hands its `ignored`
 * matcher forward slashes, and a check against the native absolute path never
 * matched there, so every pasted attachment became a note (#5607).
 */
export function isInAttachmentStore(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  return normalized === ATTACHMENTS_DIR || normalized.startsWith(`${ATTACHMENTS_DIR}/`)
}

/**
 * Whether a note row names a file in the attachment store. Such a binary row
 * is a stray, one an older Windows build made of a pasted attachment (#5607),
 * and its file is still embedded by the note in `attachments/<noteId>/`.
 * Vault files on disk are a contract every build shares: the attachment store
 * owns its files, and a note row never does. So deleting a row this answers
 * true for, from desktop, the CLI or a peer, drops the row and keeps the file.
 */
export function isAttachmentStoreRow(row: { fileType?: string | null; path: string }): boolean {
  return isBinaryNoteRow(row) && isInAttachmentStore(row.path)
}
