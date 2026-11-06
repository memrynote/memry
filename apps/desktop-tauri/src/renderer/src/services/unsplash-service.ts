import type {
  UnsplashDownloadInput,
  UnsplashDownloadResult,
  UnsplashSearchInput,
  UnsplashSearchResult
} from '@memry/contracts/unsplash-api'

import { commands } from '../../../generated/bindings'

export const unsplashService = {
  async search(input: UnsplashSearchInput): Promise<UnsplashSearchResult> {
    const response = await commands.unsplashSearch(input.query, input.page ?? null)
    if (response.status === 'photos') {
      return {
        ok: true,
        photos: response.photos,
        rateLimitRemaining: response.rateLimitRemaining
      }
    }
    return { ok: false, reason: response.reason }
  },
  // Saves a picked photo as an attachment of the note (`notes_download_unsplash_photo`).
  async download(input: UnsplashDownloadInput): Promise<UnsplashDownloadResult> {
    const response = await commands.notesDownloadUnsplashPhoto(input.noteId, input.photo)
    switch (response.status) {
      case 'saved':
        return { ok: true, ref: response.ref, credit: response.credit }
      case 'unavailable':
        return { ok: false, reason: response.reason }
      case 'writeFailed':
        return { ok: false, reason: 'write-failed' }
    }
  }
}
