export { extractYouTubeVideoId } from '@memry/shared/youtube'

export const getYouTubeThumbnailUrl = (videoId: string): string =>
  `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`

export const getYouTubeEmbedUrl = (videoId: string): string =>
  `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`
