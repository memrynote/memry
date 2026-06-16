import { getImporter } from './registry'
import { createImportContext } from './import-context'
import { flushProjectionEvents } from '../projections'
import type { ImportPreview, ImportSummary } from './types'

const controllers = new Map<string, AbortController>()

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
  const ctx = createImportContext(input.importId, controller.signal)
  try {
    return await importer.run({ sourcePaths: input.sourcePaths, options: input.options }, ctx)
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
