/**
 * Where a cover picked in `CoverPickerDialog` stores its image.
 *
 * The picker offers the same sources to every cover owner. A note keeps the
 * bytes in its own attachments folder; a Home board keeps them in
 * `.memry/home-covers/<boardId>/` (see `use-home-cover`). Each method stores
 * the image and returns the ref the cover will carry.
 *
 * @module components/note/cover-image-target
 */

import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import type { DownloadAttachmentFromUrlFailure } from '@memry/contracts/notes-api'
import type {
  UnsplashCredit,
  UnsplashDownloadFailureReason,
  UnsplashPhoto
} from '@memry/contracts/unsplash-api'
import { notesService } from '@/services/notes-service'
import { unsplashService } from '@/services/unsplash-service'

export interface CoverImageTarget {
  /** Changes with the owner, so a picker reopened for another owner starts fresh. */
  key: string
  /** Throws when the file cannot be stored. */
  upload: (file: File) => Promise<string>
  /** Throws when the image cannot be used. */
  fromVaultImage: (entry: VaultAttachmentEntry) => Promise<string>
  fromUrl: (
    url: string
  ) => Promise<{ ok: true; ref: string } | { ok: false; reason: DownloadAttachmentFromUrlFailure }>
  fromUnsplash: (
    photo: UnsplashPhoto
  ) => Promise<
    | { ok: true; ref: string; credit: UnsplashCredit }
    | { ok: false; reason: UnsplashDownloadFailureReason }
  >
}

/** A note's cover images live in the note's own attachments folder. */
export function noteCoverImageTarget(noteId: string, uploadFailed: string): CoverImageTarget {
  return {
    key: noteId,
    upload: async (file) => {
      const result = await notesService.uploadAttachment(noteId, file)
      if (!result.success || !result.path) throw new Error(result.error ?? uploadFailed)
      return result.path
    },
    fromVaultImage: async (entry) =>
      (await notesService.insertExistingAttachment(noteId, entry.ownerNoteId, entry.filename)).url,
    fromUrl: (url) => notesService.downloadAttachmentFromUrl(noteId, url),
    fromUnsplash: (photo) => unsplashService.download({ noteId, photo })
  }
}
