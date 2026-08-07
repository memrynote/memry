import type { ImporterMeta } from '@memry/contracts/import-channels'
import type { Importer } from './types'

const importers = new Map<string, Importer>()

export function registerImporter(importer: Importer): void {
  if (importers.has(importer.id)) {
    throw new Error(`Importer "${importer.id}" already registered`)
  }
  importers.set(importer.id, importer)
}

export function getImporter(id: string): Importer | undefined {
  return importers.get(id)
}

export function listImporters(): Importer[] {
  return [...importers.values()]
}

/** Serializable importer metadata for the renderer's Settings catalog, sorted by name. */
export function listImporterMeta(): ImporterMeta[] {
  return listImporters()
    .map((i) => ({
      id: i.id,
      name: i.name,
      descriptionKey: i.descriptionKey,
      fileSpec: i.fileSpec,
      supportsPreview: typeof i.preview === 'function',
      accountBased: i.accountBased === true
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Test-only: clear the registry between cases. */
export function __resetRegistry(): void {
  importers.clear()
}
