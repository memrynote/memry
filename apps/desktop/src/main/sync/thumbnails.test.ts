import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from('fake-webp'),
      info: { width: 150, height: 100 }
    })
  }))
  return { default: mockSharp }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
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

describe('thumbnails', () => {
  let generateThumbnail: typeof import('./thumbnails').generateThumbnail

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('sharp', () => {
      const mockSharp = vi.fn(() => ({
        resize: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue({
          data: Buffer.from('fake-webp'),
          info: { width: 150, height: 100 }
        })
      }))
      return { default: mockSharp }
    })
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn()
    }))
    vi.doMock('node:util', () => ({
      promisify: (fn: unknown) => fn
    }))
    vi.doMock('../lib/logger', () => ({
      createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn()
      })
    }))

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
    })
  })

  describe('video thumbnails', () => {
    it('returns null when ffmpeg is not available', async () => {
      const { execFile } = await import('node:child_process')
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await generateThumbnail('/path/to/video.mp4', 'video/mp4')
      expect(result).toBeNull()
    })

    it('generates thumbnail when ffmpeg is available', async () => {
      const { execFile } = await import('node:child_process')
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>
      mockExecFile
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/ffmpeg\n' })
        .mockResolvedValueOnce({ stdout: Buffer.from('fake-png-frame') })

      const result = await generateThumbnail('/path/to/clip.mp4', 'video/mp4')
      expect(result).not.toBeNull()
      expect(result!.format).toBe('webp')
    })
  })

  describe('unsupported types', () => {
    it('returns null for unsupported mime types', async () => {
      const result = await generateThumbnail('/path/to/file.zip', 'application/zip')
      expect(result).toBeNull()
    })

    it('returns null for audio files', async () => {
      const result = await generateThumbnail('/path/to/song.mp3', 'audio/mpeg')
      expect(result).toBeNull()
    })
  })

  describe('error handling', () => {
    it('returns null when sharp throws', async () => {
      vi.doMock('sharp', () => {
        const mockSharp = vi.fn(() => ({
          resize: vi.fn().mockReturnThis(),
          webp: vi.fn().mockReturnThis(),
          toBuffer: vi.fn().mockRejectedValue(new Error('corrupt image'))
        }))
        return { default: mockSharp }
      })
      vi.resetModules()
      vi.doMock('node:child_process', () => ({ execFile: vi.fn() }))
      vi.doMock('node:util', () => ({ promisify: (fn: unknown) => fn }))
      vi.doMock('../lib/logger', () => ({
        createLogger: () => ({
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn()
        })
      }))

      const mod = await import('./thumbnails')
      const result = await mod.generateThumbnail('/path/to/bad.png', 'image/png')
      expect(result).toBeNull()
    })
  })
})
