import { Hono } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { isOcrLanguage, ocrLanguageKey } from '../lib/ocr-languages'
import type { AppContext } from '../types'

const FILE_SUFFIX = '.traineddata.gz'

export const ocr = new Hono<AppContext>()

// Public and unauthenticated: the files are Tesseract's published models, not
// user data. Desktop pins each file's sha256, so a key never changes content.
ocr.get('/v1/:file', async (c) => {
  const file = c.req.param('file')
  const lang = file.endsWith(FILE_SUFFIX) ? file.slice(0, -FILE_SUFFIX.length) : ''
  const object = isOcrLanguage(lang) ? await c.env.OCR_DATA.get(ocrLanguageKey(lang)) : null
  if (!object) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'OCR language data not found', 404)
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  })
})
