import { describe, expect, it, vi } from 'vitest'

import { app } from '../index'

const GERMAN = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03])

function createOcrData(objects: Record<string, Uint8Array>) {
  return {
    get: vi.fn(async (key: string) => {
      const bytes = objects[key]
      if (!bytes) return null
      return { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpEtag: '"etag-1"' }
    })
  }
}

function request(path: string, ocrData: ReturnType<typeof createOcrData>) {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  return app.request(
    `http://localhost${path}`,
    {},
    { ENVIRONMENT: 'development', OCR_DATA: ocrData }
  )
}

describe('GET /ocr/v1/:lang.traineddata.gz', () => {
  it('streams an allowed language without authentication, cached as immutable', async () => {
    const ocrData = createOcrData({ 'ocr/v1/deu.traineddata.gz': GERMAN })

    const response = await request('/ocr/v1/deu.traineddata.gz', ocrData)

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GERMAN)
    expect(response.headers.get('Content-Type')).toBe('application/gzip')
    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(response.headers.get('Content-Length')).toBe('7')
    expect(response.headers.get('ETag')).toBe('"etag-1"')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it.each([
    '/ocr/v1/xyz.traineddata.gz',
    '/ocr/v1/deu.traineddata',
    '/ocr/v1/manifest.json',
    '/ocr/v1/..%2Fsecret.traineddata.gz',
    '/ocr/v1/DEU.traineddata.gz',
    '/ocr/v2/deu.traineddata.gz'
  ])('answers 404 for %s without reading storage', async (path) => {
    const ocrData = createOcrData({ 'ocr/v1/deu.traineddata.gz': GERMAN })

    const response = await request(path, ocrData)

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(ocrData.get).not.toHaveBeenCalled()
  })

  it('answers 404 for an allowed language whose data was never uploaded', async () => {
    const ocrData = createOcrData({})

    const response = await request('/ocr/v1/tur.traineddata.gz', ocrData)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'OCR language data not found' }
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(ocrData.get).toHaveBeenCalledWith('ocr/v1/tur.traineddata.gz')
  })
})
