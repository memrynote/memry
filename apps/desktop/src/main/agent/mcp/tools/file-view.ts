/**
 * vault_view_file (FB-002): one image, or one page of a PDF, from the vault as
 * image content the model can look at. Read-only. Images are downscaled in the
 * image-processing utility process; PDF pages are rendered by the PDF host that
 * text extraction uses (file-text/pdf-host.ts).
 */
import { stat } from 'fs/promises'
import path from 'path'
import { getExtension, getFileType } from '@memry/shared/file-types'

import type { PdfDocument } from '../../../file-text/pdf-host'
import type { ViewImagePayload, ViewImageSource } from '../../../image-processing/protocol'
import { AgentToolError } from '../errors'
import { ImageToolResult } from '../tool-image'

/** The long edge of every image sent to a model (FB-002 Decision 1). */
export const VIEW_IMAGE_MAX_EDGE = 1568

/** Where a note's attachments live: `attachments/<noteId>/` (vault/attachments.ts). */
const ATTACHMENTS_DIR = 'attachments'

export interface FileViewRow {
  id: string
  path: string
  title: string
  fileType: string | null
}

export interface FileViewDeps {
  vaultPath: string
  fileRow: (id: string) => FileViewRow | undefined
  prepareImage: (source: ViewImageSource, maxEdge: number) => Promise<ViewImagePayload>
  openPdf: (absolutePath: string, size: number) => Promise<PdfDocument>
}

export interface FileViewInput {
  id: string
  attachment?: string
  page?: number
}

/** The file to show, resolved and checked against the vault. */
interface ViewTarget {
  id: string
  title: string
  attachment: string | null
  /** Vault-relative, with forward slashes. */
  file: string
  fileType: 'image' | 'pdf'
}

function viewableType(fileType: string | null): 'image' | 'pdf' | null {
  return fileType === 'image' || fileType === 'pdf' ? fileType : null
}

function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    path.basename(name) === name
  )
}

function resolveTarget(row: FileViewRow, input: FileViewInput): ViewTarget {
  const fileType = row.fileType ?? 'markdown'

  if (input.attachment === undefined) {
    const viewable = viewableType(fileType)
    if (viewable) {
      return { id: row.id, title: row.title, attachment: null, file: row.path, fileType: viewable }
    }
    const what =
      fileType === 'markdown' ? 'a markdown note' : `a filed ${fileType} file, not an image or PDF`
    throw new AgentToolError(
      'VALIDATION',
      `${row.id} is ${what}. vault_view_file shows filed images and PDF pages; for an image or ` +
        'PDF a markdown note embeds, pass the note id and its file name as attachment.',
      { id: row.id, file_type: fileType }
    )
  }

  if (fileType !== 'markdown') {
    throw new AgentToolError(
      'VALIDATION',
      `attachment needs the id of a markdown note; ${row.id} is a filed ${fileType} file.`,
      { id: row.id, file_type: fileType }
    )
  }
  const name = input.attachment
  if (!isPlainFileName(name)) {
    throw new AgentToolError(
      'VALIDATION',
      `attachment must be a file name in the note's attachments folder, such as "photo.png".`,
      { id: row.id, attachment: name }
    )
  }
  const viewable = viewableType(getFileType(getExtension(name)))
  if (!viewable) {
    throw new AgentToolError(
      'VALIDATION',
      `${name} is not an image or a PDF. vault_view_file shows images and PDF pages.`,
      { id: row.id, attachment: name }
    )
  }
  return {
    id: row.id,
    title: row.title,
    attachment: name,
    file: `${ATTACHMENTS_DIR}/${row.id}/${name}`,
    fileType: viewable
  }
}

async function fileSize(vaultPath: string, target: ViewTarget): Promise<number> {
  try {
    const stats = await stat(path.join(vaultPath, target.file))
    if (stats.isFile()) return stats.size
  } catch {
    // reported below
  }
  throw new AgentToolError('NOT_FOUND', `${target.file} is not in the vault.`, {
    id: target.id,
    ...(target.attachment ? { attachment: target.attachment } : {})
  })
}

function unreadable(target: ViewTarget, error: unknown): AgentToolError {
  const reason = error instanceof Error ? error.message : String(error)
  return new AgentToolError('VALIDATION', `${target.file} could not be read: ${reason}`, {
    id: target.id
  })
}

async function prepare(
  deps: FileViewDeps,
  target: ViewTarget,
  source: ViewImageSource
): Promise<ViewImagePayload> {
  try {
    return await deps.prepareImage(source, VIEW_IMAGE_MAX_EDGE)
  } catch (error) {
    throw unreadable(target, error)
  }
}

function identity(target: ViewTarget): Record<string, unknown> {
  return {
    id: target.id,
    title: target.title,
    ...(target.attachment ? { attachment: target.attachment } : {}),
    file: target.file,
    file_type: target.fileType
  }
}

async function viewImage(
  deps: FileViewDeps,
  target: ViewTarget,
  absolutePath: string
): Promise<ImageToolResult> {
  const image = await prepare(deps, target, { kind: 'file', path: absolutePath })
  const downscaled =
    image.width !== image.sourceWidth || image.height !== image.sourceHeight
      ? `, downscaled from ${image.sourceWidth} x ${image.sourceHeight} px`
      : ''
  return new ImageToolResult(
    {
      ...identity(target),
      mime_type: image.mimeType,
      width: image.width,
      height: image.height,
      source_width: image.sourceWidth,
      source_height: image.sourceHeight,
      message: `The image follows as image content at ${image.width} x ${image.height} px${downscaled}.`
    },
    { data: Buffer.from(image.data).toString('base64'), mimeType: image.mimeType }
  )
}

async function viewPdfPage(
  deps: FileViewDeps,
  target: ViewTarget,
  absolutePath: string,
  size: number,
  page: number
): Promise<ImageToolResult> {
  let pdf: PdfDocument
  try {
    pdf = await deps.openPdf(absolutePath, size)
  } catch (error) {
    throw unreadable(target, error)
  }

  try {
    if (page > pdf.pageCount) {
      throw new AgentToolError(
        'VALIDATION',
        `${target.file} has ${pdf.pageCount} pages; page ${page} does not exist.`,
        { id: target.id, page, page_count: pdf.pageCount }
      )
    }
    const rendered = await pdf.renderPage(page, VIEW_IMAGE_MAX_EDGE)
    const image = await prepare(deps, target, { kind: 'png', data: rendered.png })
    return new ImageToolResult(
      {
        ...identity(target),
        page,
        page_count: pdf.pageCount,
        mime_type: image.mimeType,
        width: image.width,
        height: image.height,
        message: `Page ${page} of ${pdf.pageCount} follows as image content at ${image.width} x ${image.height} px.`
      },
      { data: Buffer.from(image.data).toString('base64'), mimeType: image.mimeType }
    )
  } finally {
    await pdf.close().catch(() => {})
  }
}

export async function viewVaultFile(
  deps: FileViewDeps,
  input: FileViewInput
): Promise<ImageToolResult> {
  const row = deps.fileRow(input.id)
  if (!row) throw new AgentToolError('NOT_FOUND', `Note ${input.id} not found`, { id: input.id })

  const target = resolveTarget(row, input)
  if (target.fileType === 'image' && input.page !== undefined) {
    throw new AgentToolError('VALIDATION', 'page is only for PDFs; leave it out for an image.', {
      id: target.id,
      page: input.page
    })
  }

  const size = await fileSize(deps.vaultPath, target)
  const absolutePath = path.join(deps.vaultPath, target.file)
  return target.fileType === 'image'
    ? viewImage(deps, target, absolutePath)
    : viewPdfPage(deps, target, absolutePath, size, input.page ?? 1)
}
