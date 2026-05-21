import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGenerateThumbnailInImageProcess = vi.hoisted(() => vi.fn())

vi.mock('sharp', () => {
  throw new Error('sync thumbnails must not import sharp in the main process')
})

vi.mock('../image-processing/bridge', () => ({
  generateThumbnailInImageProcess: (...args: unknown[]) =>
    mockGenerateThumbnailInImageProcess(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  })
}))

describe('thumbnails', () => {
  let generateThumbnail: typeof import('./thumbnails').generateThumbnail

  beforeEach(async () => {
    vi.resetModules()
    mockGenerateThumbnailInImageProcess.mockReset().mockResolvedValue({
      data: Buffer.from('fake-webp'),
      width: 150,
      height: 100,
      format: 'webp'
    })

    const mod = await import('./thumbnails')
    generateThumbnail = mod.generateThumbnail
  })

  describe('image thumbnails', () => {
    it('generates webp thumbnail for PNG', async () => {
      const result = await generateThumbnail('/path/to/image.png', 'image/png')
      expect(result).not.toBeNull()
      expect(result!.format).toBe('webp')
      expect(result!.width).toBe(150)
      expect(result!.height).toBe(100)
      expect(mockGenerateThumbnailInImageProcess).toHaveBeenCalledWith(
        '/path/to/image.png',
        'image/png'
      )
    })

    it('handles JPEG', async () => {
      const result = await generateThumbnail('/path/to/photo.jpg', 'image/jpeg')
      expect(result).not.toBeNull()
      expect(result!.format).toBe('webp')
    })

    it('handles GIF', async () => {
      const result = await generateThumbnail('/path/to/anim.gif', 'image/gif')
      expect(result).not.toBeNull()
    })

    it('handles WebP input', async () => {
      const result = await generateThumbnail('/path/to/img.webp', 'image/webp')
      expect(result).not.toBeNull()
    })

    it('handles SVG', async () => {
      const result = await generateThumbnail('/path/to/icon.svg', 'image/svg+xml')
      expect(result).not.toBeNull()
    })
  })

  describe('PDF placeholder', () => {
    it('generates a placeholder thumbnail for PDF', async () => {
      const result = await generateThumbnail('/path/to/doc.pdf', 'application/pdf')
      expect(result).not.toBeNull()
      expect(result!.format).toBe('webp')
      expect(mockGenerateThumbnailInImageProcess).toHaveBeenCalledWith(
        '/path/to/doc.pdf',
        'application/pdf'
      )
    })
  })

  describe('video thumbnails', () => {
    it('generates thumbnails for videos through the image utility process', async () => {
      const result = await generateThumbnail('/path/to/clip.mp4', 'video/mp4')
      expect(result).not.toBeNull()
      expect(result!.format).toBe('webp')
      expect(mockGenerateThumbnailInImageProcess).toHaveBeenCalledWith(
        '/path/to/clip.mp4',
        'video/mp4'
      )
    })
  })

  describe('unsupported types', () => {
    it('returns null for unsupported mime types without starting image processing', async () => {
      const result = await generateThumbnail('/path/to/file.zip', 'application/zip')
      expect(result).toBeNull()
      expect(mockGenerateThumbnailInImageProcess).not.toHaveBeenCalled()
    })

    it('returns null for audio files without starting image processing', async () => {
      const result = await generateThumbnail('/path/to/song.mp3', 'audio/mpeg')
      expect(result).toBeNull()
      expect(mockGenerateThumbnailInImageProcess).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('returns null when the image utility process throws', async () => {
      mockGenerateThumbnailInImageProcess.mockRejectedValue(new Error('corrupt image'))

      const result = await generateThumbnail('/path/to/bad.png', 'image/png')
      expect(result).toBeNull()
    })
  })
})
