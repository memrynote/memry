export { extractYouTubeVideoId, getYouTubeThumbnailUrl } from '@memry/shared/youtube'

export const getYouTubeEmbedUrl = (videoId: string): string =>
  `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`
