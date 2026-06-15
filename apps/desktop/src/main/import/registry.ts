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

/** Test-only: clear the registry between cases. */
export function __resetRegistry(): void {
  importers.clear()
}
