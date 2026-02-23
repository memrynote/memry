import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '../lib/logger'

const log = createLogger('Thumbnails')
const execFileAsync = promisify(execFile)

const MAX_DIMENSION = 200

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
    if (IMAGE_TYPES.has(mimeType)) {
      return await generateImageThumbnail(filePath)
    }
    if (mimeType === 'application/pdf') {
      return await generatePdfPlaceholder(filePath)
    }
    if (VIDEO_TYPES.has(mimeType)) {
      return await generateVideoThumbnail(filePath)
    }
    return null
  } catch (err) {
    log.warn('thumbnail generation failed', { filePath, mimeType, err })
    return null
  }
}

async function generateImageThumbnail(filePath: string): Promise<ThumbnailResult | null> {
  const result = await sharp(filePath)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true })

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp'
  }
}

async function generatePdfPlaceholder(_filePath: string): Promise<ThumbnailResult | null> {
  const width = 160
  const height = 200
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" rx="8" fill="#DC2626"/>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle"
          font-family="sans-serif" font-size="36" font-weight="bold" fill="white">PDF</text>
    <text x="50%" y="70%" dominant-baseline="middle" text-anchor="middle"
          font-family="sans-serif" font-size="11" fill="rgba(255,255,255,0.8)">Document</text>
  </svg>`

  const result = await sharp(Buffer.from(svg))
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true })

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp'
  }
}

async function generateVideoThumbnail(filePath: string): Promise<ThumbnailResult | null> {
  const ffmpegPath = await findFfmpeg()
  if (!ffmpegPath) {
    log.debug('ffmpeg not found, skipping video thumbnail')
    return null
  }

  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      '-i',
      filePath,
      '-ss',
      '1',
      '-vframes',
      '1',
      '-vf',
      `scale=${MAX_DIMENSION}:${MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-'
    ],
    { encoding: 'buffer', timeout: 10_000 }
  )

  const result = await sharp(stdout).webp({ quality: 80 }).toBuffer({ resolveWithObject: true })

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp'
  }
}

let cachedFfmpegPath: string | null | undefined

async function findFfmpeg(): Promise<string | null> {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath

  try {
    const { stdout } = await execFileAsync('which', ['ffmpeg'], { timeout: 3_000 })
    const found = stdout.trim()
    cachedFfmpegPath = found || null
    return cachedFfmpegPath
  } catch {
    cachedFfmpegPath = null
    return null
  }
}
