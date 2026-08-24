import fs from 'node:fs/promises'
import path from 'node:path'
import { marked } from 'marked'
import { saveCanonicalNote } from '@memry/domain-notes'
import { getNoteMetadataByPath } from '@memry/storage-data'
import type { FileType } from '@memry/shared/file-types'
import { replaceWikiLinks } from '@memry/shared/wiki-target'
import { createId } from '@memry/app-core/ids'
import type { DataDb } from './database.ts'
import { parseMarkdownNote } from '@memry/app-core/markdown'
import { normalizePath, safeFilename, type VaultConfig } from './paths.ts'
import type { NotesService } from './notes.ts'

export interface AttachmentResult {
  success: boolean
  path?: string
  absolutePath?: string
  filename?: string
  name?: string
  size?: number
  mimeType?: string
  type?: 'image' | 'file'
  error?: string
}

export interface AttachmentInfo {
  filename: string
  path: string
  absolutePath: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

export interface AttachmentsService {
  add(noteId: string, sourcePath: string): Promise<AttachmentResult>
  list(noteId: string): Promise<AttachmentInfo[]>
  delete(noteId: string, filename: string): Promise<boolean>
}

export interface ImportFilesInput {
  sourcePaths: string[]
  targetFolder?: string
}

export interface ImportedFileInfo {
  destPath: string
  filename: string
  fileType: FileType
}

export interface ImportFilesResult {
  success: boolean
  imported: number
  failed: number
  errors: string[]
  importedFiles: ImportedFileInfo[]
}

export interface ExportResult {
  success: boolean
  path?: string
  error?: string
}

export interface ExportHtmlOptions {
  includeMetadata?: boolean
}

export interface ExportPdfOptions extends ExportHtmlOptions {
  pageSize?: 'A4' | 'Letter' | 'Legal'
}

const maxAttachmentSize = 10 * 1024 * 1024
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const fileExtensions = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md'])
const audioExtensions = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'])
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv'])

const mimeTypes: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska'
}

marked.setOptions({ gfm: true, breaks: true })

function extension(filename: string): string {
  return path.extname(filename).toLowerCase().replace(/^\./, '')
}

function attachmentType(filename: string): 'image' | 'file' {
  return imageExtensions.has(extension(filename)) ? 'image' : 'file'
}

function fileType(filename: string): FileType | null {
  const ext = extension(filename)
  if (ext === 'md') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (imageExtensions.has(ext)) return 'image'
  if (audioExtensions.has(ext)) return 'audio'
  if (videoExtensions.has(ext)) return 'video'
  return null
}

function isAllowedAttachment(filename: string): boolean {
  const ext = extension(filename)
  return imageExtensions.has(ext) || fileExtensions.has(ext)
}

function mimeType(filename: string): string {
  return mimeTypes[extension(filename)] ?? 'application/octet-stream'
}

function cleanFilename(filename: string): string {
  const parsed = path.parse(path.basename(filename))
  const base = safeFilename(parsed.name)
  return `${base}${parsed.ext}`
}

function uniqueAttachmentFilename(filename: string): string {
  return `${createId('file')}-${cleanFilename(filename)}`
}

async function uniqueDestination(
  dir: string,
  filename: string
): Promise<{ filename: string; path: string }> {
  const parsed = path.parse(filename)
  let candidate = filename
  let absolutePath = path.join(dir, candidate)
  let counter = 1
  while (true) {
    try {
      await fs.access(absolutePath)
      candidate = `${parsed.name} (${counter})${parsed.ext}`
      absolutePath = path.join(dir, candidate)
      counter += 1
    } catch {
      return { filename: candidate, path: absolutePath }
    }
  }
}

function resolveTargetFolder(vaultPath: string, config: VaultConfig, targetFolder = ''): string {
  const notesRoot = path.resolve(vaultPath, config.defaultNoteFolder)
  const target = path.resolve(notesRoot, normalizePath(targetFolder))
  if (target !== notesRoot && !target.startsWith(`${notesRoot}${path.sep}`)) {
    throw new Error('Import target must stay inside the notes folder')
  }
  return target
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return escapes[char] ?? char
  })
}

function wikiLinksToText(markdown: string): string {
  return replaceWikiLinks(markdown).replace(/<!--\s*file:\{[^}]+\}\s*-->/g, '')
}

function markdownToPlainText(markdown: string): string {
  return wikiLinksToText(markdown)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '- ')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
}

function pdfEscape(text: string): string {
  return text
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function wrapLine(line: string, maxChars: number): string[] {
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
  }
  if (current) lines.push(current)
  return lines
}

function renderNotePdf(
  note: NonNullable<Awaited<ReturnType<NotesService['get']>>>,
  options: ExportPdfOptions
): string {
  const pageSizes: Record<
    NonNullable<ExportPdfOptions['pageSize']>,
    { width: number; height: number }
  > = {
    A4: { width: 595, height: 842 },
    Letter: { width: 612, height: 792 },
    Legal: { width: 612, height: 1008 }
  }
  const page = pageSizes[options.pageSize ?? 'A4']
  const lines = [
    note.title,
    '',
    ...((options.includeMetadata ?? true)
      ? [
          `Created: ${note.createdAt.slice(0, 10)}`,
          `Modified: ${note.modifiedAt.slice(0, 10)}`,
          note.tags.length ? `Tags: ${note.tags.map((tag) => `#${tag}`).join(' ')}` : '',
          ''
        ]
      : []),
    ...markdownToPlainText(note.content).split(/\r?\n/)
  ].flatMap((line) => wrapLine(line, 86))

  const content = [
    'BT',
    '/F1 12 Tf',
    '16 TL',
    `72 ${page.height - 72} Td`,
    ...lines
      .slice(0, Math.floor((page.height - 144) / 16))
      .map((line) => `(${pdfEscape(line)}) Tj T*`),
    'ET'
  ].join('\n')

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, 'utf-8')} >>\nstream\n${content}\nendstream\nendobj\n`
  ]
  let pdf = '%PDF-1.4\n%\\xE2\\xE3\\xCF\\xD3\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'))
    pdf += object
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf-8')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return pdf
}

function renderNoteHtml(
  note: NonNullable<Awaited<ReturnType<NotesService['get']>>>,
  options: ExportHtmlOptions
): string {
  const includeMetadata = options.includeMetadata ?? true
  const contentHtml = marked.parse(wikiLinksToText(note.content)) as string
  const tags = note.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')
  const metadata = includeMetadata
    ? `
      <div class="note-meta">
        <span><strong>Created:</strong> ${escapeHtml(note.createdAt.slice(0, 10))}</span>
        <span><strong>Modified:</strong> ${escapeHtml(note.modifiedAt.slice(0, 10))}</span>
      </div>
      ${tags ? `<div class="note-tags">${tags}</div>` : ''}
    `
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Memry">
  <title>${escapeHtml(note.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 40px; }
    .note-header { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #e5e5e5; }
    .note-title { font-size: 32px; line-height: 1.2; margin: 0 0 16px; }
    .note-meta { display: flex; flex-wrap: wrap; gap: 16px; color: #666; font-size: 14px; }
    .note-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .tag { background: #f0f0f0; border-radius: 4px; color: #555; display: inline-block; font-size: 13px; padding: 4px 10px; }
    img { max-width: 100%; height: auto; }
    pre { overflow-x: auto; }
  </style>
</head>
<body>
  <article>
    <header class="note-header">
      <h1 class="note-title">${escapeHtml(note.title)}</h1>
      ${metadata}
    </header>
    <main class="note-content">
      ${contentHtml}
    </main>
  </article>
</body>
</html>`
}

function propertiesFromFrontmatter(
  frontmatter: Record<string, unknown>
): Record<string, unknown> | null {
  const properties = frontmatter.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  return properties as Record<string, unknown>
}

function indexImportedMarkdown(
  dataDb: DataDb,
  relativePath: string,
  raw: string,
  stats: { mtime: Date }
): void {
  const parsed = parseMarkdownNote(raw)
  // Frontmatter keys are plain user properties — identity comes from the
  // metadata DB, never from the file
  const id = createId('note')
  const title = path.basename(relativePath, '.md')

  saveCanonicalNote(dataDb, {
    id,
    path: relativePath,
    title,
    fileType: 'markdown',
    mimeType: 'text/markdown',
    properties: propertiesFromFrontmatter(parsed.frontmatter),
    createdAt: stats.mtime.toISOString(),
    modifiedAt: stats.mtime.toISOString()
  })
}

export function createAttachmentsService({
  vaultPath,
  config,
  notes
}: {
  vaultPath: string
  config: VaultConfig
  notes: NotesService
}): AttachmentsService {
  return {
    async add(noteId, sourcePath) {
      const note = await notes.get(noteId)
      if (!note) throw new Error(`Note not found: ${noteId}`)

      const originalName = path.basename(sourcePath)
      if (!isAllowedAttachment(originalName)) {
        return { success: false, error: `File type ".${extension(originalName)}" is not allowed` }
      }

      const stats = await fs.stat(sourcePath)
      if (stats.size > maxAttachmentSize) {
        return { success: false, error: 'File too large. Maximum size is 10 MB' }
      }

      const filename = uniqueAttachmentFilename(originalName)
      const relativePath = normalizePath(path.join(config.attachmentsFolder, noteId, filename))
      const absolutePath = path.join(vaultPath, relativePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.copyFile(sourcePath, absolutePath)

      return {
        success: true,
        path: relativePath,
        absolutePath,
        filename,
        name: originalName,
        size: stats.size,
        mimeType: mimeType(originalName),
        type: attachmentType(originalName)
      }
    },

    async list(noteId) {
      const dir = path.join(vaultPath, config.attachmentsFolder, noteId)
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const attachments: AttachmentInfo[] = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const absolutePath = path.join(dir, entry.name)
          const stats = await fs.stat(absolutePath)
          attachments.push({
            filename: entry.name,
            path: normalizePath(path.join(config.attachmentsFolder, noteId, entry.name)),
            absolutePath,
            size: stats.size,
            mimeType: mimeType(entry.name),
            type: attachmentType(entry.name)
          })
        }
        return attachments
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },

    async delete(noteId, filename) {
      const safeName = path.basename(filename)
      const absolutePath = path.join(vaultPath, config.attachmentsFolder, noteId, safeName)
      await fs.rm(absolutePath, { force: true })
      return true
    }
  }
}

export function createImportFilesService({
  vaultPath,
  config,
  dataDb
}: {
  vaultPath: string
  config: VaultConfig
  dataDb: DataDb
}) {
  return async function importFiles(input: ImportFilesInput): Promise<ImportFilesResult> {
    const targetDir = resolveTargetFolder(vaultPath, config, input.targetFolder)
    await fs.mkdir(targetDir, { recursive: true })

    const errors: string[] = []
    const importedFiles: ImportedFileInfo[] = []

    for (const sourcePath of input.sourcePaths) {
      try {
        const stats = await fs.stat(sourcePath)
        if (!stats.isFile()) throw new Error('Source path is not a file')

        const sourceFilename = path.basename(sourcePath)
        const type = fileType(sourceFilename)
        if (!type) throw new Error(`Unsupported file type: .${extension(sourceFilename)}`)

        const destination = await uniqueDestination(targetDir, cleanFilename(sourceFilename))
        await fs.copyFile(sourcePath, destination.path)
        const relativePath = normalizePath(path.relative(vaultPath, destination.path))

        if (type === 'markdown' && !getNoteMetadataByPath(dataDb, relativePath)) {
          const raw = await fs.readFile(destination.path, 'utf-8')
          indexImportedMarkdown(dataDb, relativePath, raw, stats)
        }

        importedFiles.push({
          destPath: destination.path,
          filename: destination.filename,
          fileType: type
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        errors.push(`Failed to import ${path.basename(sourcePath)}: ${message}`)
      }
    }

    return {
      success: errors.length === 0,
      imported: importedFiles.length,
      failed: errors.length,
      errors,
      importedFiles
    }
  }
}

export function createExportHtmlService({ notes }: { notes: NotesService }) {
  return async function exportHtml(
    noteId: string,
    targetPath: string,
    options: ExportHtmlOptions = {}
  ): Promise<ExportResult> {
    const note = await notes.get(noteId)
    if (!note) return { success: false, error: `Note not found: ${noteId}` }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, renderNoteHtml(note, options), 'utf-8')
    return { success: true, path: targetPath }
  }
}

export function createExportPdfService({ notes }: { notes: NotesService }) {
  return async function exportPdf(
    noteId: string,
    targetPath: string,
    options: ExportPdfOptions = {}
  ): Promise<ExportResult> {
    const note = await notes.get(noteId)
    if (!note) return { success: false, error: `Note not found: ${noteId}` }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, renderNotePdf(note, options), 'utf-8')
    return { success: true, path: targetPath }
  }
}

export function createExportMarkdownService({
  vaultPath,
  notes
}: {
  vaultPath: string
  notes: NotesService
}) {
  return async function exportMarkdown(noteId: string, targetPath: string): Promise<ExportResult> {
    const note = await notes.get(noteId)
    if (!note) return { success: false, error: `Note not found: ${noteId}` }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(path.join(vaultPath, note.path), targetPath)
    return { success: true, path: targetPath }
  }
}
