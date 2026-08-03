/**
 * Machine-readable descriptors for importer warnings, errors and progress lines.
 *
 * `@memry/importers` is process-agnostic and must not depend on the desktop
 * i18n runtime, so a message carries a stable `code` (plus the values it
 * interpolates) and keeps its English text in `message`. The renderer's import
 * dialog maps `code` → i18n key at display time and falls back to `message`
 * when the code is absent or unknown.
 *
 * @module importers/messages
 */

/** Stable ids for every warning/error an importer can surface to the UI. */
export const IMPORT_MESSAGE_CODES = {
  /** Fallback used when a preview group could not be read at all. */
  readFileFailed: 'readFileFailed',

  csvNoHeaders: 'csv.noHeaders',
  csvEmptyTitle: 'csv.emptyTitle',
  csvColumns: 'csv.columns',
  csvTitleColumn: 'csv.titleColumn',

  raindropCsvEmpty: 'raindrop.csvEmpty',
  raindropHeaderNotFound: 'raindrop.headerNotFound',
  raindropRowNoUrl: 'raindrop.rowNoUrl',

  ticktickHeaderNotFound: 'ticktick.headerNotFound',
  ticktickFoldersDropped: 'ticktick.foldersDropped',
  ticktickSubtaskParentMissing: 'ticktick.subtaskParentMissing',
  ticktickUnknownPriority: 'ticktick.unknownPriority',
  ticktickUnsupportedRepeat: 'ticktick.unsupportedRepeat',
  ticktickReminderNoAnchor: 'ticktick.reminderNoAnchor',

  todoistHeaderNotFound: 'todoist.headerNotFound',
  todoistSectionFlattened: 'todoist.sectionFlattened',
  todoistOrphanComment: 'todoist.orphanComment',
  todoistEmptyTitle: 'todoist.emptyTitle',
  todoistUnknownPriority: 'todoist.unknownPriority',
  todoistUnparsedDate: 'todoist.unparsedDate',
  todoistSubtaskNoParent: 'todoist.subtaskNoParent'
} as const

export type ImportMessageCode = (typeof IMPORT_MESSAGE_CODES)[keyof typeof IMPORT_MESSAGE_CODES]

/**
 * Stable ids for the progress line an importer shows while it runs
 * (`ctx.status(...)`). Kept apart from `IMPORT_MESSAGE_CODES` so the display
 * layer can keep one exhaustive map per surface, but they travel as the same
 * `ImportMessage` shape and resolve through the same code → key lookup.
 */
export const IMPORT_STATUS_CODES = {
  /** Shared scanning lines. */
  scanningFiles: 'status.scanningFiles',
  scanningExport: 'status.scanningExport',
  /** Per-item line every importer emits while it writes: takes `{ title }`. */
  importingItem: 'status.importingItem',

  appleNotesCopyingDatabase: 'status.appleNotes.copyingDatabase',
  bearScanning: 'status.bear.scanning',
  csvImporting: 'status.csv.importing',
  evernoteScanning: 'status.evernote.scanning',
  htmlScanning: 'status.html.scanning',
  raindropImporting: 'status.raindrop.importing',
  roamReading: 'status.roam.reading',
  ticktickImporting: 'status.ticktick.importing',
  todoistImporting: 'status.todoist.importing'
} as const

export type ImportStatusCode = (typeof IMPORT_STATUS_CODES)[keyof typeof IMPORT_STATUS_CODES]

/** Values interpolated into the translated form of a message. */
export type ImportMessageParams = Record<string, string | number>

export interface ImportMessage {
  /** Stable code the display layer maps to a translation; absent → show `message`. */
  code?: ImportMessageCode | ImportStatusCode
  /** English text, rendered verbatim whenever the code cannot be translated. */
  message: string
  /** Interpolation values for the translated form. */
  params?: ImportMessageParams
}

/**
 * The fixed progress lines, English text included, so every importer emits the
 * same code/text pair instead of restating the string at its call site.
 *
 * Keyed by every `IMPORT_STATUS_CODES` name except the interpolated
 * `importingItem` (that one is `importingItemStatus`), so a code added without
 * its English line — or a line left behind after a code is dropped — fails
 * typecheck rather than reaching the dialog as an untranslatable blank.
 */
export const IMPORT_STATUS = {
  scanningFiles: { code: IMPORT_STATUS_CODES.scanningFiles, message: 'Scanning files…' },
  scanningExport: { code: IMPORT_STATUS_CODES.scanningExport, message: 'Scanning export…' },

  appleNotesCopyingDatabase: {
    code: IMPORT_STATUS_CODES.appleNotesCopyingDatabase,
    message: 'Copying Apple Notes database…'
  },
  bearScanning: { code: IMPORT_STATUS_CODES.bearScanning, message: 'Scanning Bear export…' },
  csvImporting: { code: IMPORT_STATUS_CODES.csvImporting, message: 'Importing CSV notes…' },
  evernoteScanning: {
    code: IMPORT_STATUS_CODES.evernoteScanning,
    message: 'Scanning .enex files…'
  },
  htmlScanning: { code: IMPORT_STATUS_CODES.htmlScanning, message: 'Scanning HTML files…' },
  raindropImporting: {
    code: IMPORT_STATUS_CODES.raindropImporting,
    message: 'Importing Raindrop bookmarks…'
  },
  roamReading: { code: IMPORT_STATUS_CODES.roamReading, message: 'Reading Roam export…' },
  ticktickImporting: {
    code: IMPORT_STATUS_CODES.ticktickImporting,
    message: 'Importing TickTick tasks…'
  },
  todoistImporting: {
    code: IMPORT_STATUS_CODES.todoistImporting,
    message: 'Importing Todoist tasks…'
  }
} satisfies Record<Exclude<keyof typeof IMPORT_STATUS_CODES, 'importingItem'>, ImportMessage>

/** The per-item progress line — the only status that interpolates a value. */
export function importingItemStatus(title: string): ImportMessage {
  return {
    code: IMPORT_STATUS_CODES.importingItem,
    message: `Importing ${title}`,
    params: { title }
  }
}

/** An importer failure that carries a translatable code alongside its English text. */
export class ImporterError extends Error {
  readonly code: ImportMessageCode
  readonly params?: ImportMessageParams

  constructor(code: ImportMessageCode, message: string, params?: ImportMessageParams) {
    super(message)
    this.name = 'ImporterError'
    this.code = code
    this.params = params
  }
}

/**
 * Describe a thrown value as an `ImportMessage`. Native errors keep their own
 * text with no code (the display layer renders it verbatim); anything that is
 * neither an Error nor a string falls back to the supplied descriptor.
 */
export function toImportMessage(err: unknown, fallback: ImportMessage): ImportMessage {
  if (err instanceof ImporterError) {
    return { code: err.code, message: err.message, params: err.params }
  }
  if (err instanceof Error) return { message: err.message }
  if (typeof err === 'string') return { message: err }
  return fallback
}
