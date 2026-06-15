import { getImporter } from './registry'
import { createImportContext } from './import-context'
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
