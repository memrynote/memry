/**
 * Unsplash cover source contract.
 *
 * Two operations cross the boundary: a search that returns photos to hotlink in
 * the picker, and a download that copies the chosen photo into the note's own
 * attachments folder so the cover works offline like any other vault file.
 *
 * Every URL is host-checked here rather than in the service. The renderer hands
 * a whole {@link UnsplashPhoto} back on download, and main attaches the access
 * key to the requests it makes from that object — so the boundary, not the
 * caller, decides which hosts the key may ever be sent to.
 */

import { z } from 'zod'

/** Hosts the access key may be sent to. Only the API host sees the header. */
const UNSPLASH_API_HOST = 'api.unsplash.com'
const UNSPLASH_IMAGE_HOSTS = ['images.unsplash.com', 'plus.unsplash.com'] as const
const UNSPLASH_WEB_HOSTS = ['unsplash.com', 'www.unsplash.com'] as const

function httpsUrlOnHost(hosts: readonly string[], label: string) {
  return z
    .string()
    .url()
    .refine(
      (value) => {
        let parsed: URL
        try {
          parsed = new URL(value)
        } catch {
          return false
        }
        return parsed.protocol === 'https:' && hosts.includes(parsed.hostname)
      },
      `Expected an https ${label} URL on ${hosts.join(' or ')}`
    )
}

export const UnsplashPhotoSchema = z.object({
  id: z.string().min(1).max(64),
  /** `photo.urls.thumb` — hotlinked by the picker, never proxied or cached. */
  thumbUrl: httpsUrlOnHost(UNSPLASH_IMAGE_HOSTS, 'image'),
  /** `photo.urls.small` — hotlinked by the picker. */
  previewUrl: httpsUrlOnHost(UNSPLASH_IMAGE_HOSTS, 'image'),
  /** `photo.urls.regular` — the bytes actually downloaded into the vault. */
  fullUrl: httpsUrlOnHost(UNSPLASH_IMAGE_HOSTS, 'image'),
  /** `photo.links.download_location` — the tracking endpoint, pinged once per pick. */
  downloadLocation: httpsUrlOnHost([UNSPLASH_API_HOST], 'API'),
  authorName: z.string().min(1).max(200),
  /** `photo.links.html` — the attribution link shown on the cover. */
  htmlUrl: httpsUrlOnHost(UNSPLASH_WEB_HOSTS, 'photo page'),
  blurHash: z.string().max(200).nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})

export type UnsplashPhoto = z.infer<typeof UnsplashPhotoSchema>

export const UnsplashSearchInputSchema = z.object({
  query: z.string().max(200),
  page: z.number().int().min(1).max(100).optional()
})

export type UnsplashSearchInput = z.infer<typeof UnsplashSearchInputSchema>

export const UnsplashDownloadInputSchema = z.object({
  noteId: z.string().min(1),
  photo: UnsplashPhotoSchema
})

export type UnsplashDownloadInput = z.infer<typeof UnsplashDownloadInputSchema>

/**
 * Why an Unsplash request produced nothing.
 *
 * `not-configured` means no access key is present in this build, which the
 * renderer reads as "hide the Photos tab" rather than as an error to show.
 */
export type UnsplashFailureReason = 'not-configured' | 'offline' | 'rate-limited' | 'failed'

/** {@link UnsplashFailureReason} plus the one way a download fails after the network succeeds. */
export type UnsplashDownloadFailureReason = UnsplashFailureReason | 'write-failed'

export type UnsplashSearchResult =
  | { ok: true; photos: UnsplashPhoto[]; rateLimitRemaining: number | null }
  | { ok: false; reason: UnsplashFailureReason }

export interface UnsplashCredit {
  name: string
  url: string
}

export type UnsplashDownloadResult =
  | {
      ok: true
      /** Note-relative attachment path, the same shape the upload path produces. */
      ref: string
      credit: UnsplashCredit
    }
  | { ok: false; reason: UnsplashDownloadFailureReason }
