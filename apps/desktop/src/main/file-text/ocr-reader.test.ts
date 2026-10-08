import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createOcrReader, toOcrPng } from './ocr-reader'

const FIXTURE = path.join(__dirname, 'ocr-reader.fixture.png')
const TESSDATA = path.join(__dirname, 'tessdata')

describe('OCR reader', () => {
  it('reads the text of an image file with the English data shipped in the app', async () => {
    const reader = createOcrReader(TESSDATA)

    const text = await reader.read({ kind: 'file', path: FIXTURE })

    expect(text.trim()).toBe('Heron count at dawn')
  }, 30_000)

  it('reads a rendered page handed over as PNG bytes, and keeps working after a bad file', async () => {
    const reader = createOcrReader(TESSDATA)
    const notAnImage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-ocr-')), 'x.png')
    fs.writeFileSync(notAnImage, 'not an image')

    await expect(reader.read({ kind: 'file', path: notAnImage })).rejects.toThrow()
    const text = await reader.read({ kind: 'png', data: new Uint8Array(fs.readFileSync(FIXTURE)) })

    expect(text.trim()).toBe('Heron count at dawn')
  }, 30_000)

  it('reads a small image at twice its size, grey and without transparency', async () => {
    const png = await toOcrPng({ kind: 'file', path: FIXTURE })

    expect(await sharp(png).metadata()).toMatchObject({
      width: 1440,
      height: 240,
      channels: 1,
      hasAlpha: false
    })
  })

  it('caps a very large image at 4000 px on its long edge', async () => {
    const huge = await sharp({
      create: { width: 6000, height: 3000, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer()

    const png = await toOcrPng({ kind: 'png', data: new Uint8Array(huge) })

    expect(await sharp(png).metadata()).toMatchObject({ width: 4000, height: 2000 })
  })
})
