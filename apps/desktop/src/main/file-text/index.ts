import { getIndexDatabase } from '../database'
import { publishProjectionEvent } from '../projections'
import { recognizeText, stopOcr } from './ocr-engine'
import { closePdfHost, openPdfDocument } from './pdf-host'
import { FileTextRunner } from './runner'

let runner: FileTextRunner | null = null

/**
 * Start reading text out of the vault's PDFs and images. Called once the
 * open-time index pass is done, so it never competes with it.
 */
export function startFileTextExtraction(vaultPath: string): void {
  void runner?.stop()
  runner = new FileTextRunner({
    vaultPath,
    getDb: getIndexDatabase,
    recognize: recognizeText,
    openPdf: openPdfDocument,
    release: () => {
      stopOcr()
      closePdfHost()
    },
    textChanged: (noteId) => publishProjectionEvent({ type: 'note.text-extracted', noteId })
  })
  runner.start()
}

/** Stop before the index database closes. The page in progress is read again next time. */
export async function stopFileTextExtraction(): Promise<void> {
  const stopping = runner
  runner = null
  await stopping?.stop()
}

export function fileTextNoteChanged(noteId: string): void {
  runner?.noteChanged(noteId)
}
