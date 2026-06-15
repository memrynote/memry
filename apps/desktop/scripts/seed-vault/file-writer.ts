import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import matter from 'gray-matter'

export interface NoteFile {
  /** Relative path inside the vault (e.g. "movies/Dune.md") */
  relativePath: string
  /** Frontmatter object — id/title/created/modified must be set by the caller. */
  frontmatter: Record<string, unknown>
  /** Markdown body without YAML frontmatter. */
  body: string
}

function serialize(frontmatter: Record<string, unknown>, body: string): string {
  const cleanFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined)
  )
  return matter.stringify(body.trim(), cleanFrontmatter).replace(/(?:\r?\n)+$/g, '') + '\n'
}

export function writeNoteFile(vaultRoot: string, file: NoteFile): void {
  const absolute = resolve(vaultRoot, file.relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, serialize(file.frontmatter, file.body), 'utf8')
}

export function writeNoteFiles(vaultRoot: string, files: NoteFile[]): number {
  for (const file of files) {
    writeNoteFile(vaultRoot, file)
  }
  return files.length
}
