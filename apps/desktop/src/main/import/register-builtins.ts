import { registerImporter } from './registry'
import { notionImporter } from './notion/notion-importer'
import { todoistImporter } from './todoist/todoist-importer'
import { ticktickImporter } from './ticktick/ticktick-importer'
import { markdownImporter } from './markdown/markdown-importer'
import { htmlImporter } from './html/html-importer'
import { googleKeepImporter } from './google-keep/google-keep-importer'
import { bearImporter } from './bear/bear-importer'
import { evernoteImporter } from './evernote/evernote-importer'
import { roamImporter } from './roam/roam-importer'
import { appleJournalImporter } from './apple-journal/apple-journal-importer'
import { csvImporter } from './csv/csv-importer'
import { appleNotesImporter } from './apple-notes/apple-notes-importer'

let registered = false

/** Register all built-in importers exactly once (idempotent). */
export function registerBuiltinImporters(): void {
  if (registered) return
  registered = true
  registerImporter(notionImporter)
  registerImporter(todoistImporter)
  registerImporter(ticktickImporter)
  registerImporter(markdownImporter)
  registerImporter(htmlImporter)
  registerImporter(googleKeepImporter)
  registerImporter(bearImporter)
  registerImporter(evernoteImporter)
  registerImporter(roamImporter)
  registerImporter(appleJournalImporter)
  registerImporter(csvImporter)
  // Apple Notes reads the local macOS NoteStore.sqlite — gate to macOS only.
  if (process.platform === 'darwin') {
    registerImporter(appleNotesImporter)
  }
  // OneNote requires an Azure app registration (ONENOTE_CLIENT_ID). It is built
  // and tested but registered DISABLED until that external blocker is resolved.
  // See the PR "Blockers" section. Uncomment once the client id is configured:
  // registerImporter(onenoteImporter)
}
