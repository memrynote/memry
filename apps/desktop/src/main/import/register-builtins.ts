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
import { raindropImporter } from './raindrop/raindrop-importer'
import { appleNotesImporter } from './apple-notes/apple-notes-importer'
import { onenoteImporter } from './onenote/onenote-importer'
import { isOneNoteConfigured } from './onenote/onenote-auth'

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
  registerImporter(raindropImporter)
  // Apple Notes reads the local macOS NoteStore.sqlite — gate to macOS only.
  if (process.platform === 'darwin') {
    registerImporter(appleNotesImporter)
  }
  // OneNote talks to Microsoft Graph and needs an Azure app registration;
  // until ONENOTE_CLIENT_ID is set it stays out of the import list.
  if (isOneNoteConfigured()) {
    registerImporter(onenoteImporter)
  }
}
