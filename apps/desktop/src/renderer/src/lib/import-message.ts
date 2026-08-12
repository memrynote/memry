/**
 * Display-layer translation for importer warnings/errors.
 *
 * `@memry/importers` is process-agnostic and cannot reach the i18n runtime, so
 * it emits a stable `code` plus the English text. This module is the single
 * place that maps a code to a `settings` namespace key; an absent or unknown
 * code falls back to the raw English `message` so nothing ever renders blank.
 *
 * @module renderer/lib/import-message
 */

import { getI18n } from 'react-i18next'
import type { ImportPreviewMessage } from '@memry/contracts/import-channels'
import type { ImportMessageCode, ImportStatusCode } from '@memry/importers/messages'

/**
 * Importer message code → key in the `settings` namespace.
 *
 * Typed against `ImportMessageCode` (type-only import, erased at build time) so
 * a code added in `@memry/importers` without a key here fails typecheck instead
 * of silently rendering English forever.
 */
const IMPORT_MESSAGE_KEYS: Record<ImportMessageCode, string> = {
  readFileFailed: 'import.messages.readFileFailed',

  'csv.noHeaders': 'import.messages.csv.noHeaders',
  'csv.emptyTitle': 'import.messages.csv.emptyTitle',
  'csv.columns': 'import.messages.csv.columns',
  'csv.titleColumn': 'import.messages.csv.titleColumn',

  'raindrop.csvEmpty': 'import.messages.raindrop.csvEmpty',
  'raindrop.headerNotFound': 'import.messages.raindrop.headerNotFound',
  'raindrop.rowNoUrl': 'import.messages.raindrop.rowNoUrl',

  'ticktick.headerNotFound': 'import.messages.ticktick.headerNotFound',
  'ticktick.foldersDropped': 'import.messages.ticktick.foldersDropped',
  'ticktick.subtaskParentMissing': 'import.messages.ticktick.subtaskParentMissing',
  'ticktick.unknownPriority': 'import.messages.ticktick.unknownPriority',
  'ticktick.unsupportedRepeat': 'import.messages.ticktick.unsupportedRepeat',
  'ticktick.reminderNoAnchor': 'import.messages.ticktick.reminderNoAnchor',

  'todoist.headerNotFound': 'import.messages.todoist.headerNotFound',
  'todoist.sectionFlattened': 'import.messages.todoist.sectionFlattened',
  'todoist.orphanComment': 'import.messages.todoist.orphanComment',
  'todoist.emptyTitle': 'import.messages.todoist.emptyTitle',
  'todoist.unknownPriority': 'import.messages.todoist.unknownPriority',
  'todoist.unparsedDate': 'import.messages.todoist.unparsedDate',
  'todoist.subtaskNoParent': 'import.messages.todoist.subtaskNoParent'
}

/**
 * Importer progress-line code → key in the `settings` namespace.
 *
 * Kept as its own exhaustive map (typed against `ImportStatusCode`) so a status
 * added in `@memry/importers` without a key here fails typecheck instead of
 * leaving one English line in an otherwise translated dialog.
 */
const IMPORT_STATUS_KEYS: Record<ImportStatusCode, string> = {
  'status.scanningFiles': 'import.status.scanningFiles',
  'status.scanningExport': 'import.status.scanningExport',
  'status.importingItem': 'import.status.importingItem',

  'status.appleNotes.copyingDatabase': 'import.status.appleNotes.copyingDatabase',
  'status.bear.scanning': 'import.status.bear.scanning',
  'status.csv.importing': 'import.status.csv.importing',
  'status.evernote.scanning': 'import.status.evernote.scanning',
  'status.html.scanning': 'import.status.html.scanning',
  'status.noteplan.scanning': 'import.status.noteplan.scanning',
  'status.onenote.loadingNotebooks': 'import.status.onenote.loadingNotebooks',
  'status.onenote.rateLimited': 'import.status.onenote.rateLimited',
  'status.onenote.downloadingAttachment': 'import.status.onenote.downloadingAttachment',
  'status.raindrop.importing': 'import.status.raindrop.importing',
  'status.roam.reading': 'import.status.roam.reading',
  'status.ticktick.importing': 'import.status.ticktick.importing',
  'status.todoist.importing': 'import.status.todoist.importing'
}

/** Resolve an importer warning/error to display text in the active locale. */
export function formatImportMessage(message: ImportPreviewMessage): string {
  if (typeof message === 'string') return message

  // `code` crosses IPC as a plain string, so a code this build does not know
  // about must resolve to `undefined` rather than throw.
  const keys: Record<string, string | undefined> = {
    ...IMPORT_MESSAGE_KEYS,
    ...IMPORT_STATUS_KEYS
  }
  const key = message.code ? keys[message.code] : undefined
  if (!key) return message.message

  const translated = getI18n().getFixedT(null, 'settings')(key, message.params ?? {})
  return typeof translated === 'string' && translated.length > 0 && translated !== key
    ? translated
    : message.message
}
