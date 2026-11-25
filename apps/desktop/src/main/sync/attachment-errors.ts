/**
 * An upload that fails identically on every retry, so callers drop its queued
 * row instead of backing off and retrying, and remember the file's size and
 * mtime (`refuseUpload`). The backfill offers the file again only after a
 * write changes them (#5606).
 */
export class UnsendableAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsendableAttachmentError'
  }
}

/** A zero-byte file has nothing to upload (#3414). */
export class EmptyAttachmentError extends UnsendableAttachmentError {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyAttachmentError'
  }
}

/**
 * A media file (by extension) that holds text instead of media: before #5414
 * the CRDT write-back serialized a binary note's doc over its downloaded file.
 * Uploading it would replace the note's blob with markdown on every device, so
 * it is refused, and `binary-note-restore` downloads the blob back (#5415).
 */
export class TextInMediaFileError extends UnsendableAttachmentError {
  constructor(message: string) {
    super(message)
    this.name = 'TextInMediaFileError'
  }
}

/**
 * A downloaded attachment that is no longer its note's own: a newer record
 * named another attachment while it downloaded (#5580). Landing it would put
 * older bytes on the file the row names newer ones for, so it is dropped.
 */
export class SupersededDownloadError extends Error {
  constructor(noteId: string, attachmentId: string) {
    super(`Attachment ${attachmentId} is no longer the own attachment of note ${noteId}`)
    this.name = 'SupersededDownloadError'
  }
}
