import fs from 'node:fs/promises'
import path from 'node:path'

import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  writeMarkdownNote
} from '@memry/app-core/markdown'
import { createId } from '@memry/app-core/ids'
import { saveCanonicalNote } from '@memry/domain-notes'

import { noteSpecs } from '../content/index.ts'
import { journalSpecs } from '../content/journal.ts'
import type { PostContext } from './index.ts'

const FILE_TYPES: Record<
  string,
  { fileType: 'pdf' | 'image' | 'audio' | 'video'; mimeType: string }
> = {
  '.pdf': { fileType: 'pdf', mimeType: 'application/pdf' },
  '.jpg': { fileType: 'image', mimeType: 'image/jpeg' },
  '.ogg': { fileType: 'audio', mimeType: 'audio/ogg' },
  '.webm': { fileType: 'video', mimeType: 'video/webm' }
}

/**
 * Imported binaries get their `note_metadata` row now, with the id the canvas
 * cards and bookmarks already use. Desktop's indexer adopts a binary's id from
 * note_metadata by path (apps/desktop/src/main/vault/indexer.ts indexBinaryFile),
 * so writing the row through the canonical owner (saveCanonicalNote) is what a
 * desktop import would have left behind.
 */
export async function registerImportedFiles({ ctx, dataDb }: PostContext): Promise<void> {
  for (const file of ctx.files.values()) {
    const ext = path.extname(file.path)
    const type = FILE_TYPES[ext]
    if (!type) throw new Error(`No file type for ${file.path}`)
    const stats = await fs.stat(path.join(ctx.vaultPath, file.path))
    const at = ctx.clock.ago(20, '11:00')
    saveCanonicalNote(dataDb, {
      id: file.id,
      path: file.path,
      title: path.basename(file.path, ext),
      ...type,
      fileSize: stats.size,
      createdAt: at,
      modifiedAt: at
    })
  }
}

/**
 * The CLI writes note properties under a nested `properties:` key
 * (apps/cli/src/app-core/notes.ts). Desktop reads that as legacy and lifts it to
 * top-level keys on first open (apps/desktop/src/main/vault/root-properties-migration.ts),
 * rewriting every such file and erasing the backdated mtimes below. Lifting
 * them here, with the same rule (nested keys move to the root, existing root
 * keys win), leaves that migration nothing to do.
 */
export async function liftNestedProperties({ ctx }: PostContext): Promise<number> {
  const paths = [...ctx.notes.values()].map((note) => note.path)
  const journal = await fs.readdir(path.join(ctx.vaultPath, 'journal'))
  paths.push(...journal.filter((name) => name.endsWith('.md')).map((name) => `journal/${name}`))

  let lifted = 0
  for (const relative of paths) {
    const file = path.join(ctx.vaultPath, relative)
    const parsed = parseMarkdownNote(await fs.readFile(file, 'utf8'))
    const { properties, ...root } = parsed.frontmatter
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue
    const frontmatter = { ...(properties as Record<string, unknown>), ...root }
    const next = parsed.rawFrontmatterBlock
      ? serializeParsedMarkdownNote({ ...parsed, frontmatter }, parsed.content, {
          frontmatterEdited: true
        })
      : writeMarkdownNote(frontmatter, parsed.content)
    await fs.writeFile(file, next)
    lifted++
  }
  return lifted
}

const clampToNow = (iso: string, now: Date): string =>
  new Date(Math.min(new Date(iso).getTime(), now.getTime() - 60_000)).toISOString()

/**
 * Note icons and history. The CLI has no emoji input and stamps every note
 * "now". `note_metadata.emoji` is DB-only sidecar state the indexer adopts by
 * path (indexer.ts), and desktop's index takes note dates from file stat, so
 * both the row and the file mtime are set. Rows keep clock NULL; the first
 * sync's initial seed (apps/desktop/src/main/sync/initial-seed.ts) clocks them.
 */
export async function iconsAndDates({ ctx, data }: PostContext): Promise<void> {
  const { clock } = ctx
  const setRow = data.prepare(
    'UPDATE note_metadata SET emoji = COALESCE(?, emoji), created_at = ?, modified_at = ? WHERE id = ?'
  )
  const touch = async (relative: string, created: string, modified: string): Promise<void> => {
    const file = path.join(ctx.vaultPath, relative)
    await fs.utimes(file, new Date(created), new Date(created))
    await fs.utimes(file, new Date(modified), new Date(modified))
  }

  for (const spec of noteSpecs(clock)) {
    const note = ctx.notes.get(spec.key)!
    const created = clampToNow(clock.ago(spec.created, '09:40'), clock.now)
    const modified = clampToNow(clock.ago(spec.modified, '16:20'), clock.now)
    setRow.run(spec.emoji ?? null, created, modified, note.id)
    await touch(note.path, created, modified < created ? created : modified)
  }

  for (const entry of journalSpecs()) {
    const date = clock.date(entry.day)
    const id = ctx.journal.get(date)!
    const written = clampToNow(
      clock.at(Math.min(entry.day, 0), entry.day > 0 ? '20:00' : '21:30'),
      clock.now
    )
    setRow.run(null, written, written, id)
    await touch(`journal/${date}.md`, written, written)
  }
}

/** The Recently opened widget reads data.db `recently_opened`; it is device-local and never synced. */
export function recentlyOpened({ ctx, data }: PostContext): void {
  const insert = data.prepare(
    'INSERT INTO recently_opened (id, item_id, item_type, opened_at) VALUES (?, ?, ?, ?)'
  )
  const opened: Array<[string, 'note' | 'canvas', number]> = [
    [ctx.notes.get('x-draft')!.id, 'note', 25],
    [ctx.notes.get('design-review')!.id, 'note', 70],
    [ctx.canvasIds.get('essay-board')!, 'canvas', 140],
    [ctx.notes.get('aurora-prd')!.id, 'note', 200],
    [ctx.notes.get('k-grocery')!.id, 'note', 320],
    [ctx.notes.get('r-safire')!.id, 'note', 1500],
    [ctx.canvasIds.get('aurora-map')!, 'canvas', 1700],
    [ctx.notes.get('t-trip')!.id, 'note', 2900]
  ]
  for (const [itemId, type, minutesAgo] of opened) {
    insert.run(
      createId('recent'),
      itemId,
      type,
      new Date(ctx.clock.now.getTime() - minutesAgo * 60_000).toISOString()
    )
  }
}

/** Version-history snapshots (index.db) spread over the days the essay was drafted. */
export function backdateSnapshots({ ctx, index }: PostContext): void {
  const id = ctx.notes.get('x-draft')!.id
  const rows = index
    .prepare('SELECT id FROM note_snapshots WHERE note_id = ? ORDER BY rowid')
    .all(id) as Array<{ id: string }>
  const daysAgo = [19, 11, 4]
  const update = index.prepare('UPDATE note_snapshots SET created_at = ? WHERE id = ?')
  rows.forEach((row, i) => update.run(ctx.clock.ago(daysAgo[i] ?? 1, '22:10'), row.id))
}
