import sharp from 'sharp'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import { createLogger } from '../lib/logger'
import { installWorkerLogForwarding } from '../lib/log-forward'
import type { OcrImageSource, OcrMainToWorkerMessage, OcrWorkerToMainMessage } from './ocr-protocol'

const logger = createLogger('OcrWorker')
const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('OCR worker must be run as an Electron utility process')
}

installWorkerLogForwarding('Ocr')

const langPath = process.env.MEMRY_OCR_LANG_PATH

/** Tesseract reads small type badly; a screenshot at 1x scale is read at 2x. */
const UPSCALE_BELOW_EDGE = 1600
/** Past this the time goes up and the text does not get any clearer. */
const MAX_EDGE = 4000

let engine: Promise<Worker> | null = null

function getEngine(): Promise<Worker> {
  engine ??= createWorker('eng', OEM.LSTM_ONLY, {
    langPath,
    // The default writes eng.traineddata into the working directory.
    cacheMethod: 'none',
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

/** Upright, flattened onto white, grey, and at a size Tesseract reads well. */
async function toOcrPng(source: OcrImageSource): Promise<Buffer> {
  const input = source.kind === 'file' ? source.path : Buffer.from(source.data)
  const { width = 0, height = 0 } = await sharp(input).metadata()
  const longEdge = Math.max(width, height)
  const target = longEdge < UPSCALE_BELOW_EDGE ? longEdge * 2 : Math.min(longEdge, MAX_EDGE)
  return sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize({ width: target, height: target, fit: 'inside' })
    .png()
    .toBuffer()
}

async function recognize(message: Extract<OcrMainToWorkerMessage, { type: 'recognize' }>) {
  try {
    const png = await toOcrPng(message.source)
    const { data } = await (await getEngine()).recognize(png)
    parentPort.postMessage({
      type: 'recognized',
      requestId: message.requestId,
      text: data.text
    } satisfies OcrWorkerToMainMessage)
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error)
    } satisfies OcrWorkerToMainMessage)
  }
}

parentPort.on('message', (event) => {
  const message = event.data as OcrMainToWorkerMessage
  if (message.type === 'recognize') {
    void recognize(message)
  } else if (message.type === 'shutdown') {
    process.exit(0)
  }
})

process.on('uncaughtException', (error) => {
  logger.error('Uncaught OCR worker error', { message: error.message })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled OCR worker rejection', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

parentPort.postMessage({ type: 'ready' } satisfies OcrWorkerToMainMessage)
