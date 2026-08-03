/**
 * Machine-readable descriptors for importer warnings and errors.
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

/** Values interpolated into the translated form of a message. */
export type ImportMessageParams = Record<string, string | number>

export interface ImportMessage {
  /** Stable code the display layer maps to a translation; absent → show `message`. */
  code?: ImportMessageCode
  /** English text, rendered verbatim whenever the code cannot be translated. */
  message: string
  /** Interpolation values for the translated form. */
  params?: ImportMessageParams
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
