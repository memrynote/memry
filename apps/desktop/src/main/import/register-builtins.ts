import { registerImporter } from './registry'
import { notionImporter } from './notion/notion-importer'
import { todoistImporter } from './todoist/todoist-importer'
import { markdownImporter } from './markdown/markdown-importer'
import { htmlImporter } from './html/html-importer'

let registered = false

/** Register all built-in importers exactly once (idempotent). */
export function registerBuiltinImporters(): void {
  if (registered) return
  registered = true
  registerImporter(notionImporter)
  registerImporter(todoistImporter)
  registerImporter(markdownImporter)
  registerImporter(htmlImporter)
}
