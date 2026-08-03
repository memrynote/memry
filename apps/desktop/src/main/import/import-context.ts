import { ImportChannels } from '@memry/contracts/import-channels'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import type { ImportContext, ImportProgress, ImportSummary } from './types'

const logger = createLogger('Import')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

export function createImportContext(importId: string, signal: AbortSignal): ImportContext {
  let imported = 0
  let attachments = 0
  let skipped = 0
  let completed = 0
  let total = 0
  let phase: ImportProgress['phase'] = 'scanning'
  let status = ''
  const failed: { item: string; error: string }[] = []

  const toSummary = (): ImportSummary => ({ imported, attachments, skipped, failed })

  const emit = (done = false): void => {
    const payload: ImportProgress = {
      importId,
      phase,
      status,
      imported,
      attachments,
      skipped,
      failed: failed.length,
      completed,
      total,
      done,
      summary: done ? toSummary() : undefined
    }
    broadcastToAllWindows(ImportChannels.events.PROGRESS, payload)
  }

  return {
    signal,
    status: (message) => {
      status = message
      emit()
    },
    setPhase: (next) => {
      phase = next
      emit(next === 'done')
    },
    reportProgress: (c, t) => {
      completed = c
      total = t
      emit()
    },
    reportImported: () => {
      imported++
      emit()
    },
    reportAttachment: () => {
      attachments++
      emit()
    },
    reportSkipped: (item, reason) => {
      skipped++
      logger.info('import skipped', { item, reason })
      emit()
    },
    reportFailed: (item, error) => {
      failed.push({ item, error: errorMessage(error) })
      logger.warn('import failed', { item })
      emit()
    },
    isCancelled: () => signal.aborted,
    toSummary
  }
}
