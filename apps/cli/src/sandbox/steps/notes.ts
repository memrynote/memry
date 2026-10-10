import fs from 'node:fs/promises'
import path from 'node:path'

import { createId } from '@memry/app-core/ids'

import { createBody, type Attached } from '../body.ts'
import { importedFiles, noteSpecs } from '../content/index.ts'
import { journalSpecs } from '../content/journal.ts'
import { essayDrafts } from '../content/life.ts'
import { assetPath, need, type AssetName, type NoteRef, type SandboxStep } from '../context.ts'

/**
 * Creates every note, journal day and imported file up front, so tasks,
 * events and canvases can point at them before the bodies are written.
 */
export const createShells: SandboxStep = async (ctx) => {
  for (const spec of noteSpecs(ctx.clock)) {
    if (ctx.notes.has(spec.key)) throw new Error(`Duplicate note key ${spec.key}`)
    const note = await ctx.app.notes.create({
      title: spec.title,
      folder: spec.folder,
      tags: spec.tags
    })
    // A title clash gets a `-2` suffix (apps/cli/src/app-core/notes.ts); wiki links would then miss.
    if (path.posix.basename(note.path) !== `${spec.title}.md`) {
      throw new Error(
        `Note "${spec.title}" landed at ${note.path}; titles must be unique and filename-safe`
      )
    }
    ctx.notes.set(spec.key, { id: note.id, path: note.path, title: spec.title })
  }

  for (const entry of journalSpecs()) {
    const date = ctx.clock.date(entry.day)
    const note = await ctx.app.journal.write(date, '')
    ctx.journal.set(date, note.id)
  }

  for (const file of importedFiles) {
    const result = await ctx.app.importFiles({
      sourcePaths: [assetPath(file.asset)],
      targetFolder: file.folder
    })
    const imported = result.importedFiles[0]
    if (!result.success || !imported)
      throw new Error(`Import of ${file.asset} failed: ${result.errors.join('; ')}`)
    ctx.files.set(file.key, {
      id: createId('note'),
      path: path.relative(ctx.vaultPath, imported.destPath).split(path.sep).join('/'),
      asset: file.asset
    })
  }
}

const noteRelative = (note: NoteRef, target: string): string =>
  path.posix.relative(path.posix.dirname(note.path), target)

const isMedia = (name: string): boolean => /\.(ogg|webm)$/.test(name)

/**
 * Images and PDFs go through the CLI attachment service, which also queues the
 * upload. It refuses audio and video (apps/cli/src/app-core/note-files.ts
 * isAllowedAttachment), so those are copied into the same per-note folder by
 * hand; desktop's startup sweep queues their upload.
 */
async function attach(
  ctx: Parameters<SandboxStep>[0],
  note: NoteRef,
  asset: AssetName
): Promise<Attached> {
  if (isMedia(asset)) {
    return writeAttachment(
      ctx,
      note,
      asset,
      await fs.readFile(assetPath(asset)),
      asset.endsWith('.ogg') ? 'audio/ogg' : 'video/webm'
    )
  }
  const result = await ctx.app.attachments.add(note.id, assetPath(asset))
  if (!result.success || !result.path) throw new Error(`Attaching ${asset} failed: ${result.error}`)
  return {
    ref: noteRelative(note, result.path),
    name: asset,
    size: result.size ?? 0,
    mimeType: result.mimeType ?? 'application/octet-stream'
  }
}

async function writeAttachment(
  ctx: Parameters<SandboxStep>[0],
  note: NoteRef,
  name: string,
  bytes: Buffer | string,
  mimeType: string
): Promise<Attached> {
  const relative = `attachments/${note.id}/${name}`
  await fs.mkdir(path.join(ctx.vaultPath, 'attachments', note.id), { recursive: true })
  await fs.writeFile(path.join(ctx.vaultPath, relative), bytes)
  return { ref: noteRelative(note, relative), name, size: Buffer.byteLength(bytes), mimeType }
}

export const writeBodies: SandboxStep = async (ctx) => {
  for (const spec of noteSpecs(ctx.clock)) {
    const note = need(ctx.notes, spec.key, 'note')
    const attached = new Map<string, Attached>()
    for (const asset of spec.assets ?? []) attached.set(asset, await attach(ctx, note, asset))
    for (const file of spec.generated ?? []) {
      attached.set(
        file.name,
        await writeAttachment(ctx, note, file.name, file.content, file.mimeType)
      )
    }
    const b = createBody(ctx, spec.key, attached)
    await ctx.app.notes.update({
      id: note.id,
      content: spec.body(b),
      properties: spec.properties?.(b)
    })
  }
}

export const writeJournal: SandboxStep = async (ctx) => {
  for (const entry of journalSpecs()) {
    const date = ctx.clock.date(entry.day)
    const id = need(ctx.journal, date, 'journal day')
    const b = createBody(ctx, `journal-${date}`, new Map())
    await ctx.app.notes.update({
      id,
      content: entry.body(b),
      tags: entry.tags,
      properties: entry.properties
    })
  }
}

/** Earlier essay drafts become version-history snapshots; the last draft stays the body. */
export const writeVersions: SandboxStep = async (ctx) => {
  const { id } = need(ctx.notes, 'x-draft', 'note')
  const reasons = ['manual', 'timer', 'significant'] as const
  for (const [index, draft] of essayDrafts.slice(0, -1).entries()) {
    await ctx.app.notes.update({ id, content: draft })
    await ctx.app.versions.create(id, reasons[index % reasons.length], true)
  }
  await ctx.app.notes.update({ id, content: essayDrafts[essayDrafts.length - 1] })
}
