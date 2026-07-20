import { createLogger } from '../lib/logger'
import { installWorkerLogForwarding } from '../lib/log-forward'
import { generateThumbnailInWorker, processInboxImageFile } from './operations'
import type {
  ImageProcessingMainToWorkerMessage,
  ImageProcessingWorkerToMainMessage
} from './protocol'

const logger = createLogger('ImageProcessingWorker')
const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('image-processing worker must be run as an Electron utility process')
}

installWorkerLogForwarding('ImageProcessing')

async function handleGenerateThumbnail(
  message: Extract<ImageProcessingMainToWorkerMessage, { type: 'generate-thumbnail' }>
): Promise<void> {
  try {
    const result = await generateThumbnailInWorker(message.filePath, message.mimeType)
    parentPort.postMessage({
      type: 'thumbnail-result',
      requestId: message.requestId,
      result
    } satisfies ImageProcessingWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies ImageProcessingWorkerToMainMessage)
  }
}

async function handleProcessInboxImage(
  message: Extract<ImageProcessingMainToWorkerMessage, { type: 'process-inbox-image' }>
): Promise<void> {
  try {
    const result = await processInboxImageFile(message.filePath)
    parentPort.postMessage({
      type: 'inbox-image-result',
      requestId: message.requestId,
      result
    } satisfies ImageProcessingWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies ImageProcessingWorkerToMainMessage)
  }
}

parentPort.on('message', (event) => {
  const message = event.data as ImageProcessingMainToWorkerMessage

  switch (message.type) {
    case 'generate-thumbnail':
      void handleGenerateThumbnail(message)
      break
    case 'process-inbox-image':
      void handleProcessInboxImage(message)
      break
    case 'shutdown':
      process.exit(0)
  }
})

process.on('uncaughtException', (error) => {
  logger.error('Uncaught image-processing worker error', {
    message: error instanceof Error ? error.message : String(error)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled image-processing worker rejection', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

parentPort.postMessage({ type: 'ready' } satisfies ImageProcessingWorkerToMainMessage)
