import sharp from 'sharp'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import type { OcrImageSource, OcrLanguageSet } from './ocr-protocol'

/** Tesseract reads small type badly; a screenshot at 1x scale is read at 2x. */
const UPSCALE_BELOW_EDGE = 1600
/** Past this the time goes up and the text does not get any clearer. */
const MAX_EDGE = 4000

/** Upright, flattened onto white, grey, and at a size Tesseract reads well. */
export async function toOcrPng(source: OcrImageSource): Promise<Buffer> {
  const input = Buffer.from(source.data)
  const { width = 0, height = 0 } = await sharp(input).metadata()
  const longEdge = Math.max(width, height)
  const target = longEdge < UPSCALE_BELOW_EDGE ? longEdge * 2 : Math.min(longEdge, MAX_EDGE)
  return sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')
    .resize({ width: target, height: target, fit: 'inside' })
    .png()
    .toBuffer()
}

/** One Tesseract worker for `languages`, started on the first read. */
export function createOcrReader(languages: OcrLanguageSet): {
  read(source: OcrImageSource): Promise<string>
} {
  let engine: Promise<Worker> | null = null

  const getEngine = (): Promise<Worker> => {
    // tesseract.js looks for `<cachePath>/<code>.traineddata` first and falls
    // back to `<langPath>/<code>.traineddata.gz`. `readOnly` never writes there.
    engine ??= createWorker(languages.codes.join('+'), OEM.LSTM_ONLY, {
      langPath: languages.bundledDir,
      cachePath: languages.downloadDir,
      cacheMethod: 'readOnly',
      gzip: true,
      // Without a handler tesseract.js rethrows a failed job as an uncaught
      // exception; the job's own promise still rejects.
      errorHandler: () => {}
    }).catch((error: unknown) => {
      engine = null
      throw error
    })
    return engine
  }

  return {
    async read(source) {
      const png = await toOcrPng(source)
      const { data } = await (await getEngine()).recognize(png)
      return data.text
    }
  }
}
