import { generateThumbnailInImageProcess } from '../image-processing/bridge'
import { createLogger } from '../lib/logger'

const log = createLogger('Thumbnails')

export interface ThumbnailResult {
  data: Buffer
  width: number
  height: number
  format: 'webp' | 'png'
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])

export async function generateThumbnail(
  filePath: string,
  mimeType: string
): Promise<ThumbnailResult | null> {
  try {
    if (IMAGE_TYPES.has(mimeType) || mimeType === 'application/pdf' || VIDEO_TYPES.has(mimeType)) {
      return await generateThumbnailInImageProcess(filePath, mimeType)
    }
    return null
  } catch (err) {
    log.warn('thumbnail generation failed', { filePath, mimeType, err })
    return null
  }
}
