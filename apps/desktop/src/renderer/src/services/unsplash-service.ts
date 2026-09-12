import type {
  UnsplashDownloadInput,
  UnsplashDownloadResult,
  UnsplashSearchInput,
  UnsplashSearchResult
} from '@memry/contracts/unsplash-api'

export const unsplashService = {
  search(input: UnsplashSearchInput): Promise<UnsplashSearchResult> {
    return window.api.unsplash.search(input)
  },
  download(input: UnsplashDownloadInput): Promise<UnsplashDownloadResult> {
    return window.api.unsplash.download(input)
  }
}
