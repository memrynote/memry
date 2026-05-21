import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSharp = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => vi.fn())

vi.mock('sharp', () => ({
  default: mockSharp
}))

vi.mock('node:child_process', () => ({
  execFile: mockExecFile
}))

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  })
}))

import { generateThumbnailInWorker, processInboxImageFile } from './operations'

function mockSharpPipeline(options: {
  metadata?: Record<string, unknown>
  thumbnail?: Buffer
  webp?: Buffer
  width?: number
  height?: number
}) {
  return {
    metadata: vi.fn().mockResolvedValue(
      options.metadata ?? {
        width: 640,
        height: 480,
        format: 'jpeg',
        exif: Buffer.from([1])
      }
    ),
    clone: vi.fn(() => ({
      resize: vi.fn(() => ({
        jpeg: vi.fn(() => ({
          toBuffer: vi.fn().mockResolvedValue(options.thumbnail ?? Buffer.from('thumb'))
        }))
      }))
    })),
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: options.webp ?? Buffer.from('fake-webp'),
      info: {
        width: options.width ?? 150,
        height: options.height ?? 100
      }
    })
  }
}

describe('image-processing operations', () => {
  beforeEach(() => {
    mockSharp.mockReset()
    mockExecFile.mockReset()
    mockSharp.mockImplementation(() => mockSharpPipeline({}))
  })

  it('reads inbox image metadata and creates a jpeg thumbnail from a file path', async () => {
    const result = await processInboxImageFile('/tmp/photo.jpg')

    expect(mockSharp).toHaveBeenCalledWith('/tmp/photo.jpg')
    expect(result).toEqual({
      metadata: {
        format: 'jpeg',
        width: 640,
        height: 480,
        hasExif: true
      },
      thumbnailData: Buffer.from('thumb')
    })
  })

  it('generates image and PDF thumbnails without main-process sharp imports', async () => {
    await expect(generateThumbnailInWorker('/tmp/image.png', 'image/png')).resolves.toEqual({
      data: Buffer.from('fake-webp'),
      width: 150,
      height: 100,
      format: 'webp'
    })

    await expect(generateThumbnailInWorker('/tmp/doc.pdf', 'application/pdf')).resolves.toEqual({
      data: Buffer.from('fake-webp'),
      width: 150,
      height: 100,
      format: 'webp'
    })
  })

  it('generates video thumbnails when ffmpeg is available', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '/usr/local/bin/ffmpeg\n' })
      .mockResolvedValueOnce({ stdout: Buffer.from('fake-png-frame') })

    await expect(generateThumbnailInWorker('/tmp/video.mp4', 'video/mp4')).resolves.toEqual({
      data: Buffer.from('fake-webp'),
      width: 150,
      height: 100,
      format: 'webp'
    })
    expect(mockSharp).toHaveBeenLastCalledWith(Buffer.from('fake-png-frame'))
  })

  it('returns null for unsupported types and processing failures', async () => {
    await expect(generateThumbnailInWorker('/tmp/song.mp3', 'audio/mpeg')).resolves.toBeNull()

    mockSharp.mockImplementationOnce(() => ({
      resize: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockRejectedValue(new Error('corrupt image'))
    }))
    await expect(generateThumbnailInWorker('/tmp/bad.png', 'image/png')).resolves.toBeNull()
  })
})
