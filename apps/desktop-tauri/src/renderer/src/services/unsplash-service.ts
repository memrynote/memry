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
  // Saving a picked photo as a note attachment is Step 14 (#3531), which owns the attachment
  // writer. Until it lands this stays on the not-ported shim.
  download(input: UnsplashDownloadInput): Promise<UnsplashDownloadResult> {
    return window.api.unsplash.download(input)
  }
}
