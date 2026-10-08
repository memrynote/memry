import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

import { prepareViewImage } from './operations'

const MAX_EDGE = 1568

let dir: string

async function writePng(name: string, width: number, height: number): Promise<string> {
  const file = path.join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .png()
    .toFile(file)
  return file
}

async function sizeOf(data: Uint8Array): Promise<{ width?: number; height?: number }> {
  return sharp(Buffer.from(data)).metadata()
}

describe('prepareViewImage', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-view-image-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('downscales a large image so its long edge is 1568 px and reports the source size', async () => {
    const file = await writePng('wide.png', 3136, 2000)

    const result = await prepareViewImage({ kind: 'file', path: file }, MAX_EDGE)

    expect(result).toMatchObject({
      mimeType: 'image/png',
      width: 1568,
      height: 1000,
      sourceWidth: 3136,
      sourceHeight: 2000
    })
    expect(await sizeOf(result.data)).toMatchObject({ width: 1568, height: 1000 })
  })

  it('keeps a small image at its own size', async () => {
    const file = await writePng('small.png', 400, 300)

    const result = await prepareViewImage({ kind: 'file', path: file }, MAX_EDGE)

    expect(result).toMatchObject({ width: 400, height: 300, sourceWidth: 400, sourceHeight: 300 })
  })

  it('turns a photo upright from its EXIF orientation before measuring it', async () => {
    const file = path.join(dir, 'rotated.jpg')
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#888888' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(file)

    const result = await prepareViewImage({ kind: 'file', path: file }, MAX_EDGE)

    expect(result).toMatchObject({
      width: 784,
      height: 1568,
      sourceWidth: 1000,
      sourceHeight: 2000
    })
  })

  it('sends an image whose PNG would be over 1 MiB as JPEG', async () => {
    const side = 1200
    const noise = await sharp(randomBytes(side * side * 3), {
      raw: { width: side, height: side, channels: 3 }
    })
      .png()
      .toBuffer()

    const result = await prepareViewImage({ kind: 'png', data: noise }, MAX_EDGE)

    expect(result.mimeType).toBe('image/jpeg')
    expect(result.data.byteLength).toBeLessThan(noise.byteLength)
    expect((await sharp(Buffer.from(result.data)).metadata()).format).toBe('jpeg')
  })

  it('takes rendered PNG bytes as well as a file', async () => {
    const png = await sharp({
      create: { width: 1200, height: 1553, channels: 4, background: '#ffffff' }
    })
      .png()
      .toBuffer()

    const result = await prepareViewImage({ kind: 'png', data: png }, MAX_EDGE)

    expect(result).toMatchObject({ mimeType: 'image/png', width: 1200, height: 1553 })
  })

  it('rejects a file that is not an image', async () => {
    const file = path.join(dir, 'broken.png')
    fs.writeFileSync(file, 'not an image')

    await expect(prepareViewImage({ kind: 'file', path: file }, MAX_EDGE)).rejects.toThrow()
  })
})
