import { broadcastToAllWindows } from '../lib/window-broadcast'
import { ImportChannels, MAX_SKIPPED_REASON_GROUPS } from '@memry/contracts/import-channels'
import type { ImportMessage, ImportSkippedGroup } from '@memry/contracts/import-channels'
import { createLogger } from '../lib/logger'
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
  let status: string | ImportMessage = ''
  const failed: { item: string; error: string }[] = []
  // Keyed by code (one group per reason kind) or by the raw text when the
  // reason carries no code.
  const skippedReasons = new Map<string, ImportSkippedGroup>()
  let freeTextReasonGroups = 0

  const toSummary = (): ImportSummary => {
    const summary: ImportSummary = { imported, attachments, skipped, failed }
    if (skippedReasons.size > 0) summary.skippedReasons = [...skippedReasons.values()]
    return summary
  }

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
      if (reason) {
        const code = typeof reason === 'string' ? undefined : reason.code
        const key = code ?? (typeof reason === 'string' ? reason : reason.message)
        const group = skippedReasons.get(key)
        if (group) group.count++
        // A coded reason is always kept: the code space is bounded by
        // IMPORT_MESSAGE_CODES, and the cap exists for free text — an import
        // whose early items hit several per-extension attachment errors must
        // not bury the locked-notes line behind them.
        else if (code || freeTextReasonGroups < MAX_SKIPPED_REASON_GROUPS) {
          if (!code) freeTextReasonGroups++
          skippedReasons.set(key, { reason, count: 1 })
        }
      }
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
