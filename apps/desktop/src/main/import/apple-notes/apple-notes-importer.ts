/**
 * Apple Notes importer (macOS only).
 *
 * Reads a copy of the Apple Notes NoteStore.sqlite database, decodes each
 * note's gzipped protobuf body via the pure @memry/apple-notes-import package,
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
import { createNote, updateNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import {
  decodeNote,
  docToMarkdown,
  mapNote,
  ATTACHMENT_TOKEN_PREFIX,
  type AppleNoteRow
} from '@memry/apple-notes-import'

const ROOT = 'Apple Notes'
const NOTE_DB_REL = 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite'
const logger = createLogger('AppleNotesImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

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
  note: number | null
}

function defaultDbPath(): string {
  return path.join(os.homedir(), NOTE_DB_REL)
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
  const rows = db.prepare('SELECT z_ent, z_name FROM z_primarykey').all() as {
    z_ent: number
    z_name: string
  }[]
  const byName = new Map(rows.map((r) => [r.z_name, r.z_ent]))
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
  fileSpec: {
    label: 'Apple Notes database (NoteStore.sqlite)',
    extensions: ['sqlite'],
    allowMultiple: false
  },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    if (process.platform !== 'darwin') {
      ctx.reportFailed('Apple Notes', 'Apple Notes import is only available on macOS')
      return ctx.toSummary()
    }

    const sourcePath = input.sourcePaths[0] || defaultDbPath()
    let tempPath: string | null = null
    let db: Database.Database | null = null

    try {
      ctx.setPhase('scanning')
      ctx.status('Copying Apple Notes database…')
      tempPath = await copyToTemp(sourcePath)

      db = new Database(tempPath, { readonly: true, fileMustExist: true })
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

      const mediaStmt = db.prepare(
        'SELECT a.zidentifier AS identifier, a.zgeneration1 AS generation, ' +
          'a.zfilename AS filename, b.znote AS note ' +
          'FROM ziccloudsyncingobject AS a ' +
          'JOIN ziccloudsyncingobject AS b ON b.zmedia = a.z_pk ' +
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
          ctx.status(`Importing ${title}`)

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

          const note = await createNote({
            title: mapped.title,
            content: body,
            folder: mapped.folder,
            created: mapped.created,
            modified: mapped.modified
          })
          ctx.reportImported()

          // Resolve inline image attachments, save them, rewrite the tokens.
          let rewritten = body
          for (const attachmentId of new Set(attachmentIds)) {
            const token = `${ATTACHMENT_TOKEN_PREFIX}${attachmentId}`
            try {
              const media = mediaStmt.get(attachmentId) as MediaRow | undefined
              if (!media || !media.filename || media.note == null) {
                ctx.reportSkipped(attachmentId, 'attachment file not found')
                continue
              }
              const account = accountById.get(folder?.owner ?? -1)
              const bytes = await readMediaBytes(account?.identifier, media)
              if (!bytes) {
                ctx.reportSkipped(media.filename, 'attachment bytes unreadable')
                continue
              }
              const result = await saveAttachment(note.id, bytes, media.filename)
              if (result.success && result.path) {
                rewritten = rewritten.split(`](${token})`).join(`](${result.path})`)
                ctx.reportAttachment()
              } else {
                ctx.reportSkipped(media.filename, result.error)
              }
            } catch (error) {
              ctx.reportSkipped(attachmentId, errorMessage(error))
            }
          }

          if (rewritten !== body) {
            await updateNote({ id: note.id, content: rewritten })
          }
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
 * Read an attachment's bytes from the Apple Notes Media directory on disk.
 * Falls back to the flat Media path when the per-account path is unavailable.
 */
async function readMediaBytes(
  accountIdentifier: string | undefined,
  media: MediaRow
): Promise<Buffer | null> {
  const base = path.join(os.homedir(), 'Library/Group Containers/group.com.apple.notes')
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
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate)
    } catch {
      // try next candidate
    }
  }
  return null
}
