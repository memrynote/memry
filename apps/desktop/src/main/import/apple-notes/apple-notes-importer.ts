/**
 * Apple Notes importer (macOS only).
 *
 * Reads a copy of the Apple Notes NoteStore.sqlite database, decodes each
 * note's gzipped protobuf body via the pure @memry/importers/apple-notes package,
 * converts it to markdown, resolves inline image attachments, and creates a
 * note under `Apple Notes/<account>/<folder chain>`.
 *
 * Database access (temp snapshot, entity ids, account/folder rows, the ZPARENT
 * walk) is shared with the dialog's folder picker in `note-store.ts`.
 *
 * Options (`ImportInput.options`): `folderIds` limits the run to the picked
 * ICFolder identifiers and `includeUnfiledNotes` covers notes outside any
 * folder. Absent — or an empty selection — imports everything.
 *
 * Registration is gated to `process.platform === 'darwin'` by the orchestrator
 * (register-builtins); run() additionally early-returns on non-macOS as a
 * defensive guard. The original NoteStore.sqlite is never mutated — we operate
 * on a read-only temp copy.
 */

import path from 'path'
import fs from 'fs/promises'
import zlib from 'zlib'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import {
  decodeNote,
  docToMarkdown,
  mapNote,
  ATTACHMENT_TOKEN_PREFIX,
  type AppleNoteRow
} from '@memry/importers/apple-notes'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import type { AppleNotesImportOptionsInput } from '@memry/contracts/import-channels'
import {
  ACCESS_DENIED_HINT,
  FOLDER_TYPE_SMART,
  FOLDER_TYPE_TRASH,
  defaultContainerDir,
  folderPath,
  isAccessDenied,
  loadAccounts,
  loadFolders,
  loadPrimaryKeys,
  openNoteStore,
  type FolderRow
} from './note-store'

const ROOT = 'Apple Notes'
const logger = createLogger('AppleNotesImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

interface NoteDataRow {
  pk: number
  title: string | null
  folder: number | null
  hexdata: string | null
  created: number | null
  modified: number | null
  passwordProtected: number | null
}

interface MediaRow {
  identifier: string | null
  generation: string | null
  filename: string | null
}

/**
 * A note's inline attachment resolved by its ICAttachment identifier. URL cards
 * carry `typeUti`/`title`/`url` and no file; file/image attachments carry the
 * `media*` fields from the joined ICMedia row (where the real filename lives).
 */
interface AttachmentRow {
  typeUti: string | null
  title: string | null
  url: string | null
  mediaId: string | null
  generation: string | null
  filename: string | null
}

/**
 * Read the dialog's folder selection out of the loose options bag. An absent or
 * malformed field means "no selection" — i.e. import everything — so a payload
 * from an older build, or a run started after the folder scan failed, still
 * imports the whole library.
 */
function parseSelection(options: Record<string, unknown> | undefined): {
  folderIds: Set<string>
  includeUnfiled: boolean
} {
  const raw = (options ?? {}) as AppleNotesImportOptionsInput
  const folderIds = Array.isArray(raw.folderIds)
    ? raw.folderIds.filter((id): id is string => typeof id === 'string')
    : []
  return { folderIds: new Set(folderIds), includeUnfiled: raw.includeUnfiledNotes === true }
}

export const appleNotesImporter: Importer = {
  id: 'apple-notes',
  name: 'Apple Notes',
  descriptionKey: 'import.sources.apple-notes',
  // Pick the protected Notes container folder; selecting it grants recursive
  // read access (database + attachments) without Full Disk Access.
  fileSpec: {
    label: 'Apple Notes data folder',
    extensions: ['sqlite'],
    allowMultiple: false,
    directory: true,
    chooseLabelKey: 'import.dialog.chooseFolder',
    folderHintKey: 'import.dialog.folderHint',
    defaultPath: defaultContainerDir(),
    message:
      'Select the “group.com.apple.notes” folder to let Memry read your Apple Notes — ' +
      'notes and attachments. No Full Disk Access needed.'
  },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    if (process.platform !== 'darwin') {
      ctx.reportFailed('Apple Notes', 'Apple Notes import is only available on macOS')
      return ctx.toSummary()
    }

    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.appleNotesCopyingDatabase)
    // The user selects the container folder (preferred — its grant also covers
    // attachments) or a NoteStore.sqlite file directly.
    const store = await openNoteStore(input.sourcePaths[0] || defaultContainerDir())
    const db = store.db
    const mediaBase = store.mediaBase

    try {
      const keys = loadPrimaryKeys(db)
      const selection = parseSelection(input.options)

      // ---- Accounts ----
      const accounts = loadAccounts(db, keys)
      const accountById = new Map(accounts.map((a) => [a.pk, a]))
      const multiAccount = accounts.length > 1

      // ---- Folders ----
      const folders = loadFolders(db, keys)
      const folderById = new Map<number, FolderRow>(folders.map((f) => [f.pk, f]))
      // Folder chains are shared by every note in a folder — resolve once.
      const folderPathCache = new Map<number, string[]>()
      const trashFolders = new Set<number>(
        folders.filter((f) => f.folderType === FOLDER_TYPE_TRASH).map((f) => f.pk)
      )

      // ---- Notes (with body data) ----
      const notes = db
        .prepare(
          'SELECT nd.znote AS pk, zcso.ztitle1 AS title, zcso.zfolder AS folder, ' +
            'hex(nd.zdata) AS hexdata, zcso.zcreationdate1 AS created, ' +
            'zcso.zmodificationdate1 AS modified, zcso.zispasswordprotected AS passwordProtected ' +
            'FROM zicnotedata AS nd ' +
            'JOIN ziccloudsyncingobject AS zcso ON zcso.z_pk = nd.znote ' +
            'WHERE zcso.z_ent = ? AND zcso.ztitle1 IS NOT NULL'
        )
        .all(keys.ICNote) as NoteDataRow[]

      // The note body references the ICAttachment identifier. URL cards hold
      // their link on the attachment row itself; file/image attachments point
      // (ZMEDIA) at an ICMedia row that carries the real filename + generation.
      const attachmentStmt = db.prepare(
        'SELECT a.ztypeuti AS typeUti, a.ztitle AS title, a.zurlstring AS url, ' +
          'm.zidentifier AS mediaId, m.zgeneration1 AS generation, m.zfilename AS filename ' +
          'FROM ziccloudsyncingobject AS a ' +
          'LEFT JOIN ziccloudsyncingobject AS m ON m.z_pk = a.zmedia ' +
          'WHERE a.zidentifier = ?'
      )

      // No picked folders and no unfiled opt-in → the whole library, as before.
      const hasSelection = selection.folderIds.size > 0 || selection.includeUnfiled
      const importable = notes.filter((n) => {
        if (n.folder != null && trashFolders.has(n.folder)) return false
        if (!hasSelection) return true
        if (n.folder == null) return selection.includeUnfiled
        const identifier = folderById.get(n.folder)?.identifier
        return identifier != null && selection.folderIds.has(identifier)
      })
      const total = importable.length
      let done = 0

      ctx.setPhase('importing')

      for (const row of importable) {
        if (ctx.isCancelled()) return ctx.toSummary()

        const title = row.title ?? 'Untitled'

        if (row.passwordProtected) {
          ctx.reportSkipped(title, 'note is password protected')
          done++
          ctx.reportProgress(done, total)
          continue
        }

        try {
          ctx.status(importingItemStatus(title))

          const folder = row.folder != null ? folderById.get(row.folder) : undefined
          const skipFolder = folder?.folderType === FOLDER_TYPE_SMART
          const accountName =
            folder?.owner != null ? accountById.get(folder.owner)?.name : undefined

          const meta: AppleNoteRow = {
            title,
            accountName: accountName ?? null,
            folderPath: skipFolder ? [] : folderPath(folder, folderById, folderPathCache),
            createdCoreTime: row.created ?? null,
            modifiedCoreTime: row.modified ?? null
          }
          const mapped = mapNote(ROOT, meta, multiAccount)

          let body = ''
          let attachmentIds: string[] = []
          if (row.hexdata) {
            const gz = Buffer.from(row.hexdata, 'hex')
            const protobufBytes = zlib.gunzipSync(gz)
            const converted = docToMarkdown(decodeNote(protobufBytes))
            body = converted.markdown
            attachmentIds = converted.attachmentIds
          }

          // Pre-generate the note id so attachments can be saved under it before
          // the note exists. The note is then created once with the fully resolved
          // body — no create-then-update round trip (whose getNoteById can miss the
          // just-written cache mid-import, throw, and drop every rewrite).
          const noteId = generateNoteId()

          // Resolve inline attachments into the body: URL cards → markdown links,
          // images → embedded `![](path)`, other files → a clickable file block.
          let rewritten = body
          for (const attachmentId of new Set(attachmentIds)) {
            const token = `${ATTACHMENT_TOKEN_PREFIX}${attachmentId}`
            try {
              const att = attachmentStmt.get(attachmentId) as AttachmentRow | undefined
              if (!att) {
                ctx.reportSkipped(attachmentId, 'attachment not found')
                continue
              }

              // URL link card — no file on disk; emit a markdown link, dropping
              // the image (`!`) prefix the converter wrote for the placeholder.
              if (att.typeUti === 'public.url' && att.url) {
                const label = att.title?.trim() || att.url
                rewritten = rewritten.split(`![](${token})`).join(`[${label}](${att.url})`)
                continue
              }

              if (!att.filename || !att.mediaId) {
                ctx.reportSkipped(att.title || attachmentId, 'attachment file not found')
                continue
              }

              const account = accountById.get(folder?.owner ?? -1)
              const bytes = await readMediaBytes(mediaBase, account?.identifier, {
                identifier: att.mediaId,
                generation: att.generation,
                filename: att.filename
              })
              if (!bytes) {
                ctx.reportSkipped(att.filename, 'attachment bytes unreadable')
                continue
              }
              const result = await saveAttachment(noteId, bytes, att.filename)
              const md = attachmentMarkdown(result)
              if (md) {
                // Images embed inline (url-encoded); other files become a
                // clickable file block. Replaces the whole `![](token)` placeholder.
                rewritten = rewritten.split(`![](${token})`).join(md)
                ctx.reportAttachment()
              } else {
                ctx.reportSkipped(att.filename, result.error)
              }
            } catch (error) {
              ctx.reportSkipped(attachmentId, errorMessage(error))
            }
          }

          await createNote({
            id: noteId,
            title: mapped.title,
            content: rewritten,
            folder: mapped.folder,
            created: mapped.created,
            modified: mapped.modified
          })
          ctx.reportImported()
        } catch (error) {
          logger.warn('apple note import failed', { title })
          ctx.reportFailed(title, error)
        }

        done++
        ctx.reportProgress(done, total)
      }

      return ctx.toSummary()
    } finally {
      await store.close()
    }
  }
}

/**
 * Read an attachment's bytes from the Apple Notes Media directory on disk,
 * relative to the selected container folder (`base`). Falls back to the flat
 * Media path when the per-account path is unavailable.
 */
async function readMediaBytes(
  base: string,
  accountIdentifier: string | undefined,
  media: MediaRow
): Promise<Buffer | null> {
  const candidates: string[] = []
  if (accountIdentifier && media.identifier && media.filename) {
    candidates.push(
      path.join(
        base,
        'Accounts',
        accountIdentifier,
        'Media',
        media.identifier,
        media.generation ?? '',
        media.filename
      )
    )
  }
  if (media.identifier && media.filename) {
    candidates.push(
      path.join(base, 'Media', media.identifier, media.generation ?? '', media.filename)
    )
  }
  let accessDenied = false
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate)
    } catch (error) {
      // ENOENT → try the next candidate; permission denial → surface FDA hint.
      if (isAccessDenied(error)) accessDenied = true
    }
  }
  if (accessDenied) throw new Error(ACCESS_DENIED_HINT)
  return null
}
