import { getImporter } from './registry'
import { createImportContext } from './import-context'
import type { ImportSummary } from './types'

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

export function cancelImport(importId: string): void {
  controllers.get(importId)?.abort()
}
