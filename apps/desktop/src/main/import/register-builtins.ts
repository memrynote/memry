import { registerImporter } from './registry'
import { notionImporter } from './notion/notion-importer'

let registered = false

/** Register all built-in importers exactly once (idempotent). */
export function registerBuiltinImporters(): void {
  if (registered) return
  registered = true
  registerImporter(notionImporter)
}
