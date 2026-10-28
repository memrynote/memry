export { extractYouTubeVideoId, getYouTubeThumbnailUrl } from '@memry/shared/youtube'

// The loopback page, not youtube-nocookie.com directly: the app's own origin is not http(s), and
// YouTube answers an embedder it cannot identify with Error 153.
export { toYoutubeEmbedUrl as getYouTubeEmbedUrl } from './memry-file-url'
