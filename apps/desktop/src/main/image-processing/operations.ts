import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createLogger } from '../lib/logger'
import type {
  ImageProcessingThumbnailPayload,
  InboxImageProcessingPayload,
  ViewImagePayload,
  ViewImageSource
} from './protocol'

const log = createLogger('ImageProcessing')
const execFileAsync = promisify(execFile)

const MAX_THUMBNAIL_DIMENSION = 200
const MAX_INBOX_THUMBNAIL_DIMENSION = 400
/** A larger PNG goes out as JPEG, which keeps one agent image near a megabyte. */
const VIEW_IMAGE_PNG_MAX_BYTES = 1024 * 1024
const VIEW_IMAGE_JPEG_QUALITY = 85

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])

type SharpFactory = typeof import('sharp').default

let sharpPromise: Promise<SharpFactory> | null = null
let cachedFfmpegPath: string | null | undefined

async function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= import('sharp').then((mod) => {
    const loaded = mod as unknown as { default?: SharpFactory }
    return loaded.default ?? (mod as unknown as SharpFactory)
  })
  return sharpPromise
}

export async function processInboxImageFile(
  filePath: string
): Promise<InboxImageProcessingPayload | null> {
  const sharp = await loadSharp()
  const pipeline = sharp(filePath)
  const metadata = await pipeline.metadata()

  if (!metadata.width || !metadata.height) {
    return null
  }

  let thumbnailData: Buffer | null = null
  try {
    thumbnailData = await pipeline
      .clone()
      .resize(MAX_INBOX_THUMBNAIL_DIMENSION, MAX_INBOX_THUMBNAIL_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 })
      .toBuffer()
  } catch (error) {
    log.warn('inbox image thumbnail generation failed', { filePath, error })
  }

  return {
    metadata: {
      format: metadata.format || 'unknown',
      width: metadata.width,
      height: metadata.height,
      hasExif: Boolean(metadata.exif || metadata.icc)
    },
    thumbnailData
  }
}

/**
 * An upright copy of the image, its long edge at most `maxEdge` px, as PNG, or
 * as JPEG on white when the PNG would pass VIEW_IMAGE_PNG_MAX_BYTES. An animated
 * image gives its first frame. Throws when the bytes are not an image.
 */
export async function prepareViewImage(
  source: ViewImageSource,
  maxEdge: number
): Promise<ViewImagePayload> {
  const sharp = await loadSharp()
  const input = source.kind === 'file' ? source.path : Buffer.from(source.data)
  const upright = sharp(input).rotate()
  const metadata = await upright.metadata()
  if (!metadata.width || !metadata.height) throw new Error('The file has no image size')
  const turned = (metadata.orientation ?? 1) >= 5
  const sourceWidth = turned ? metadata.height : metadata.width
  const sourceHeight = turned ? metadata.width : metadata.height

  const resized = upright.resize({
    width: maxEdge,
    height: maxEdge,
    fit: 'inside',
    withoutEnlargement: true
  })
  const png = await resized.clone().png().toBuffer({ resolveWithObject: true })
  const encoded =
    png.data.byteLength <= VIEW_IMAGE_PNG_MAX_BYTES
      ? { ...png, mimeType: 'image/png' as const }
      : {
          ...(await resized
            .clone()
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: VIEW_IMAGE_JPEG_QUALITY })
            .toBuffer({ resolveWithObject: true })),
          mimeType: 'image/jpeg' as const
        }

  return {
    data: encoded.data,
    mimeType: encoded.mimeType,
    width: encoded.info.width,
    height: encoded.info.height,
    sourceWidth,
    sourceHeight
  }
}

export async function generateThumbnailInWorker(
  filePath: string,
  mimeType: string
): Promise<ImageProcessingThumbnailPayload | null> {
  try {
    if (IMAGE_TYPES.has(mimeType)) {
      return await generateImageThumbnail(filePath)
    }
    if (mimeType === 'application/pdf') {
      return await generatePdfPlaceholder()
    }
    if (VIDEO_TYPES.has(mimeType)) {
      return await generateVideoThumbnail(filePath)
    }
    return null
  } catch (error) {
    log.warn('thumbnail generation failed', { filePath, mimeType, error })
    return null
  }
}

async function generateImageThumbnail(filePath: string): Promise<ImageProcessingThumbnailPayload> {
  const sharp = await loadSharp()
  const result = await sharp(filePath)
    .resize(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true })

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp'
  }
}

async function generatePdfPlaceholder(): Promise<ImageProcessingThumbnailPayload> {
  const sharp = await loadSharp()
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

async function generateVideoThumbnail(
  filePath: string
): Promise<ImageProcessingThumbnailPayload | null> {
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
      `scale=${MAX_THUMBNAIL_DIMENSION}:${MAX_THUMBNAIL_DIMENSION}:force_original_aspect_ratio=decrease`,
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-'
    ],
    { encoding: 'buffer', timeout: 10_000 }
  )

  const sharp = await loadSharp()
  const result = await sharp(stdout).webp({ quality: 80 }).toBuffer({ resolveWithObject: true })

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp'
  }
}

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
