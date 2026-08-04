/**
 * Apple Notes importer (macOS only).
 *
 * Reads a copy of the Apple Notes NoteStore.sqlite database, decodes each
 * note's gzipped protobuf body via the pure @memry/importers/apple-notes package,
 * converts it to markdown, resolves inline image attachments, and creates a
 * note under `Apple Notes/<account>/<folder>`.
 *
 * Registration is gated to `process.platform === 'darwin'` by the orchestrator
 * (register-builtins); run() additionally early-returns on non-macOS as a
 * defensive guard. The original NoteStore.sqlite is never mutated — we operate
 * on a read-only temp copy.
 */

import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import zlib from 'zlib'
import Database from 'better-sqlite3'
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

const ROOT = 'Apple Notes'
const NOTE_CONTAINER_REL = 'Library/Group Containers/group.com.apple.notes'
const NOTE_DB = 'NoteStore.sqlite'
const logger = createLogger('AppleNotesImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

/** macOS TCC / filesystem permission denial reading the protected Notes data. */
function isAccessDenied(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EPERM' || code === 'EACCES' || code === 'SQLITE_CANTOPEN'
}

const ACCESS_DENIED_HINT =
  'Memry could not read the Apple Notes data. Click “Select Apple Notes folder” and ' +
  'choose the “group.com.apple.notes” folder when the picker opens — that grants access ' +
  'without Full Disk Access. If it still fails, grant Full Disk Access to Memry (or ' +
  '“Electron” in development) in System Settings → Privacy & Security, then reopen the app.'

/** Folder type discriminator from ICFolder.ZFOLDERTYPE. */
const FOLDER_TYPE_TRASH = 1
const FOLDER_TYPE_SMART = 3

interface PrimaryKeys {
  ICAccount: number
  ICFolder: number
  ICNote: number
  ICMedia: number
}

interface AccountRow {
  pk: number
  name: string
  identifier: string
}

interface FolderRow {
  pk: number
  title: string | null
  parent: number | null
  identifier: string | null
  folderType: number | null
  owner: number | null
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

function defaultContainerDir(): string {
  return path.join(os.homedir(), NOTE_CONTAINER_REL)
}

/**
 * Copy the chosen NoteStore.sqlite (+ WAL/SHM sidecars when present) to a temp
 * file so we read a consistent, never-mutated snapshot.
 */
async function copyToTemp(sourcePath: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-apple-notes-'))
  const dest = path.join(tmpDir, 'NoteStore.sqlite')
  await fs.copyFile(sourcePath, dest)
  for (const suffix of ['-wal', '-shm']) {
    try {
      await fs.copyFile(sourcePath + suffix, dest + suffix)
    } catch {
      // Sidecar absent (DB checkpointed) — fine.
    }
  }
  return dest
}

function loadPrimaryKeys(db: Database.Database): PrimaryKeys {
  // better-sqlite3 keys rows by the schema's real column case — the Apple Notes
  // DB declares Z_ENT/Z_NAME uppercase, so an unaliased `z_name` read returns
  // undefined and every entity id falls back to -1 (→ zero rows). Alias to a
  // stable lowercase key. (Every other query already aliases its columns.)
  const rows = db.prepare('SELECT z_ent AS ent, z_name AS name FROM z_primarykey').all() as {
    ent: number
    name: string
  }[]
  const byName = new Map(rows.map((r) => [r.name, r.ent]))
  return {
    ICAccount: byName.get('ICAccount') ?? -1,
    ICFolder: byName.get('ICFolder') ?? -1,
    ICNote: byName.get('ICNote') ?? -1,
    ICMedia: byName.get('ICMedia') ?? -1
  }
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

    // The user selects the container folder (preferred — its grant also covers
    // attachments) or a NoteStore.sqlite file directly. Resolve both the DB path
    // and the media base from whatever was chosen.
    const selected = input.sourcePaths[0] || defaultContainerDir()
    const isDbFile = selected.toLowerCase().endsWith('.sqlite')
    const dbPath = isDbFile ? selected : path.join(selected, NOTE_DB)
    const mediaBase = isDbFile ? path.dirname(selected) : selected

    let tempPath: string | null = null
    let db: Database.Database | null = null

    try {
      ctx.setPhase('scanning')
      ctx.status(IMPORT_STATUS.appleNotesCopyingDatabase)
      try {
        tempPath = await copyToTemp(dbPath)
        db = new Database(tempPath, { readonly: true, fileMustExist: true })
      } catch (error) {
        if (isAccessDenied(error)) throw new Error(ACCESS_DENIED_HINT)
        if (errorCode(error) === 'ENOENT') {
          throw new Error(
            `Apple Notes database not found at ${dbPath}. Open the Notes app once to ` +
              'create it, or select the “group.com.apple.notes” folder.'
          )
        }
        throw error
      }
      const keys = loadPrimaryKeys(db)

      // ---- Accounts ----
      const accounts = db
        .prepare(
          'SELECT z_pk AS pk, zname AS name, zidentifier AS identifier ' +
            'FROM ziccloudsyncingobject WHERE z_ent = ?'
        )
        .all(keys.ICAccount) as AccountRow[]
      const accountById = new Map<number, AccountRow>(accounts.map((a) => [a.pk, a]))
      const multiAccount = accounts.length > 1

      // ---- Folders ----
      const folders = db
        .prepare(
          'SELECT z_pk AS pk, ztitle2 AS title, zparent AS parent, zidentifier AS identifier, ' +
            'zfoldertype AS folderType, zowner AS owner ' +
            'FROM ziccloudsyncingobject WHERE z_ent = ?'
        )
        .all(keys.ICFolder) as FolderRow[]
      const folderById = new Map<number, FolderRow>(folders.map((f) => [f.pk, f]))
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

      const importable = notes.filter((n) => n.folder == null || !trashFolders.has(n.folder))
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
            folderName: skipFolder ? null : folderDisplayName(folder),
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
      if (db) {
        try {
          db.close()
        } catch {
          // ignore close errors
        }
      }
      if (tempPath) {
        await fs.rm(path.dirname(tempPath), { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/** Default ("Notes") and account-root folders map to the importer root. */
function folderDisplayName(folder: FolderRow | undefined): string | null {
  if (!folder || !folder.title) return null
  if (folder.identifier && folder.identifier.startsWith('DefaultFolder')) return null
  return folder.title
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
