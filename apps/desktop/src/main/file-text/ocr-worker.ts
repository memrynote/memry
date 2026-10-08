import { createLogger } from '../lib/logger'
import { installWorkerLogForwarding } from '../lib/log-forward'
import type { OcrMainToWorkerMessage, OcrWorkerToMainMessage } from './ocr-protocol'
import { createOcrReader } from './ocr-reader'

const logger = createLogger('OcrWorker')
const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('OCR worker must be run as an Electron utility process')
}

installWorkerLogForwarding('Ocr')

const reader = createOcrReader(process.env.MEMRY_OCR_LANG_PATH)

async function recognize(
  message: Extract<OcrMainToWorkerMessage, { type: 'recognize' }>
): Promise<void> {
  try {
    parentPort.postMessage({
      type: 'recognized',
      requestId: message.requestId,
      text: await reader.read(message.source)
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
