import { toSafeToken } from '@memry/contracts/telemetry-api'
import { getImporter } from './registry'
import { createImportContext } from './import-context'
import { flushProjectionEvents } from '../projections'
import { trackMainLog } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'
import { recordActivity } from '../vault/activity-log'
import { VAULT_ACTIVITY_MAX_ITEMS } from '@memry/contracts/vault-activity-api'
import type { ImportMessage } from '@memry/contracts/import-channels'
import type { ImportContext, ImportPreview, ImportSummary } from './types'

const controllers = new Map<string, AbortController>()

function trackImportCompleted(importerId: string, summary: ImportSummary, canceled: boolean): void {
  trackMainEvent('import_completed', {
    surface: 'vault',
    action: toSafeToken(importerId, 'importer'),
    source: 'import',
    result: canceled ? 'canceled' : summary.failed.length > 0 ? 'failed' : 'success',
    metrics: { itemCount: summary.imported, value: summary.failed.length }
  })
  if (summary.failed.length > 0) {
    // Per-item failures are user-visible in the summary dialog; aggregate them
    // here rather than tracking each item (imports can fail in bursts).
    trackMainLog('warn', {
      scope: 'import',
      action: importerId,
      metrics: { itemCount: summary.failed.length, value: summary.imported }
    })
  }
}

function reasonText(reason: string | ImportMessage | undefined): string | undefined {
  if (!reason) return undefined
  return typeof reason === 'string' ? reason : reason.message
}

/**
 * The import dialog's summary disappears with the dialog. The activity log
 * keeps one line per run, with the failed and skipped items named, so what an
 * import left behind can still be read afterwards.
 */
function recordImportRun(
  importerId: string,
  summary: ImportSummary,
  skippedItems: string[],
  canceled: boolean
): void {
  const failedItems = summary.failed.map(({ item, error }) => `${item} \u2014 ${error}`)
  const items = [...failedItems, ...skippedItems].slice(0, VAULT_ACTIVITY_MAX_ITEMS)
  recordActivity({
    kind: 'import',
    source: 'import',
    importer: importerId,
    ...(canceled ? { reason: 'import-canceled' } : {}),
    counts: {
      imported: summary.imported,
      attachments: summary.attachments,
      skipped: summary.skipped,
      failed: summary.failed.length
    },
    ...(items.length > 0 ? { items } : {})
  })
}

export interface RunImportInput {
  importId: string
  importerId: string
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const importer = getImporter(input.importerId)
  if (!importer) throw new Error(`Unknown importer: ${input.importerId}`)

  const controller = new AbortController()
  controllers.set(input.importId, controller)
  const baseCtx = createImportContext(input.importId, controller.signal)
  // Skipped items are only counted and grouped in the summary; keep a bounded
  // list of their names for the activity log.
  const skippedItems: string[] = []
  const ctx: ImportContext = {
    ...baseCtx,
    reportSkipped: (item, reason) => {
      if (skippedItems.length < VAULT_ACTIVITY_MAX_ITEMS) {
        const text = reasonText(reason)
        skippedItems.push(text ? `${item} \u2014 ${text}` : item)
      }
      baseCtx.reportSkipped(item, reason)
    }
  }
  try {
    const summary = await importer.run(
      { sourcePaths: input.sourcePaths, options: input.options },
      ctx
    )
    trackImportCompleted(input.importerId, summary, controller.signal.aborted)
    recordImportRun(input.importerId, summary, skippedItems, controller.signal.aborted)
    return summary
  } catch (error) {
    recordActivity({
      kind: 'failed',
      source: 'import',
      importer: input.importerId,
      reason: 'import-failed',
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    controllers.delete(input.importId)
    // Importers write notes through the async projection pipeline; their
    // note_cache rows (which the sidebar's notes list reads) are only persisted
    // when the projection bus drains. Flush here so a post-import refetch sees
    // every imported note instead of empty folders until the next reload.
    await flushProjectionEvents()
    ctx.setPhase('done')
  }
}

export interface PreviewImportInput {
  importId: string
  importerId: string
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export async function previewImport(input: PreviewImportInput): Promise<ImportPreview> {
  const importer = getImporter(input.importerId)
  if (!importer) throw new Error(`Unknown importer: ${input.importerId}`)
  if (!importer.preview) throw new Error(`Importer "${input.importerId}" has no preview`)

  const controller = new AbortController()
  controllers.set(input.importId, controller)
  try {
    return await importer.preview(
      { sourcePaths: input.sourcePaths, options: input.options },
      controller.signal
    )
  } finally {
    controllers.delete(input.importId)
  }
}

export function cancelImport(importId: string): void {
  controllers.get(importId)?.abort()
}
