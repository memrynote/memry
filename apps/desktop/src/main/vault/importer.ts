import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { getExtension, getFileType } from '@memry/shared/file-types'
import extractZip from 'extract-zip'
import { normalizeRelativePath, safeJoin } from '../lib/paths'
import { atomicWrite, ensureDirectory } from './file-ops'
import { ensureFrontmatter } from './frontmatter'

export type ImportSourceType = 'files' | 'obsidian' | 'notion'

export interface ImportCandidate {
  sourcePath: string
  relativePath: string
  cleanupRoot?: string
}

export interface ImportedVaultFile {
  destPath: string
  filename: string
  fileType: string
}

const SKIPPED_ENTRY_NAMES = new Set([
  '.DS_Store',
  '.obsidian',
  '.git',
  '.trash',
  '__MACOSX',
  'node_modules'
])

function shouldSkipEntry(name: string): boolean {
  return SKIPPED_ENTRY_NAMES.has(name)
}

async function collectFromDirectory(
  rootPath: string,
  currentPath: string,
  candidates: ImportCandidate[]
): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true })

  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue

    const fullPath = path.join(currentPath, entry.name)

    if (entry.isDirectory()) {
      await collectFromDirectory(rootPath, fullPath, candidates)
      continue
    }

    if (!entry.isFile()) continue

    candidates.push({
      sourcePath: fullPath,
      relativePath: normalizeRelativePath(path.relative(rootPath, fullPath))
    })
  }
}

async function collectFromNotionZip(sourcePath: string): Promise<ImportCandidate[]> {
  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-notion-import-'))

  try {
    await extractZip(sourcePath, { dir: extractRoot })

    const candidates: ImportCandidate[] = []
    await collectFromDirectory(extractRoot, extractRoot, candidates)
    return candidates.map((candidate) => ({ ...candidate, cleanupRoot: extractRoot }))
  } catch (error) {
    await fs.rm(extractRoot, { recursive: true, force: true })
    throw error
  }
}

export async function collectImportCandidates(
  sourcePath: string,
  sourceType: ImportSourceType = 'files'
): Promise<ImportCandidate[]> {
  const stats = await fs.stat(sourcePath)

  if (stats.isFile()) {
    if (sourceType === 'notion' && getExtension(sourcePath) === 'zip') {
      return collectFromNotionZip(sourcePath)
    }

    return [{ sourcePath, relativePath: path.basename(sourcePath) }]
  }

  if (!stats.isDirectory()) {
    throw new Error('Import source must be a file or directory')
  }

  const candidates: ImportCandidate[] = []
  await collectFromDirectory(sourcePath, sourcePath, candidates)
  return candidates
}

function resolveDestinationPath(targetRoot: string, relativePath: string): string {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  const destination = safeJoin(targetRoot, ...segments)
  if (!destination) {
    throw new Error(`Import path escapes target folder: ${relativePath}`)
  }
  return destination
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function generateUniqueImportPath(filePath: string): Promise<string> {
  let candidate = filePath
  let counter = 1
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)

  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`)
    counter++
  }

  return candidate
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (char === ',') {
      row.push(cell)
      cell = ''
      continue
    }

    if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    if (char === '\r') {
      if (input[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  if (cell.length > 0 || row.length > 0 || input.endsWith(',')) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

function escapeMarkdownTableCell(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim()
  return escaped.length > 0 ? escaped : ' '
}

function csvToMarkdownNote(csv: string, title: string): string {
  const rows = parseCsv(csv)

  if (rows.length === 0) {
    return `# ${title}\n\n_Empty CSV export._`
  }

  const header = rows[0]
  const bodyRows = rows.slice(1)
  const width = Math.max(header.length, ...bodyRows.map((row) => row.length), 1)
  const normalizedHeader = Array.from({ length: width }, (_, index) => header[index] ?? '')
  const separator = Array.from({ length: width }, () => '---')
  const normalizedRows = bodyRows.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? '')
  )

  const table = [normalizedHeader, separator, ...normalizedRows]
    .map((row) => `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`)
    .join('\n')

  return `# ${title}\n\n${table}`
}

async function writeMarkdownImport(sourcePath: string, destPath: string): Promise<void> {
  const raw = await fs.readFile(sourcePath, 'utf8')
  const content = ensureFrontmatter(raw, destPath)
  await atomicWrite(destPath, content)
}

async function writeNotionCsvImport(sourcePath: string, destPath: string): Promise<void> {
  const raw = await fs.readFile(sourcePath, 'utf8')
  const title = path.basename(destPath, path.extname(destPath))
  await atomicWrite(destPath, csvToMarkdownNote(raw, title))
}

export async function importCandidate(
  candidate: ImportCandidate,
  targetRoot: string,
  sourceType: ImportSourceType
): Promise<ImportedVaultFile> {
  const extension = getExtension(candidate.sourcePath)
  const isNotionCsv = sourceType === 'notion' && extension === 'csv'
  const destinationRelativePath = isNotionCsv
    ? candidate.relativePath.replace(/\.csv$/i, '.md')
    : candidate.relativePath
  const destinationPath = await generateUniqueImportPath(
    resolveDestinationPath(targetRoot, destinationRelativePath)
  )

  await ensureDirectory(path.dirname(destinationPath))

  if (isNotionCsv) {
    await writeNotionCsvImport(candidate.sourcePath, destinationPath)
  } else if (extension === 'md') {
    await writeMarkdownImport(candidate.sourcePath, destinationPath)
  } else {
    await fs.copyFile(candidate.sourcePath, destinationPath)
  }

  return {
    destPath: destinationPath,
    filename: path.basename(candidate.sourcePath),
    fileType: isNotionCsv
      ? 'markdown'
      : (getFileType(getExtension(destinationPath)) ?? 'unsupported')
  }
}
