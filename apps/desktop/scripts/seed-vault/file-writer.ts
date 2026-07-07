import { writeFileSync, mkdirSync, utimesSync } from 'fs'
import { dirname, resolve } from 'path'
import { writeMarkdownNote } from '../../../../packages/app-core/src/markdown.ts'

export interface NoteFile {
  /** Relative path inside the vault (e.g. "movies/Dune.md") */
  relativePath: string
  /** User frontmatter keys only — no Memry keys (id/title/created/modified). */
  frontmatter: Record<string, unknown>
  /** Markdown body without YAML frontmatter. */
  body: string
  /** ISO mtime to stamp on the file (dates come from fs stats, not frontmatter). */
  modified?: string
}

function serialize(frontmatter: Record<string, unknown>, body: string): string {
  // Use the runtime Obsidian-style emitter so seeded files are byte-identical
  // to what the app writes (no quoted YAML 1.1 dates -> no spurious watcher
  // diff on first save). writeMarkdownNote filters undefined keys and emits a
  // bare body when none remain; keep the seed's trailing-newline convention.
  return writeMarkdownNote(frontmatter, body) + '\n'
}

function writeNoteFile(vaultRoot: string, file: NoteFile): void {
  const absolute = resolve(vaultRoot, file.relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, serialize(file.frontmatter, file.body), 'utf8')
  if (file.modified) {
    const mtime = new Date(file.modified)
    utimesSync(absolute, mtime, mtime)
  }
}

export function writeNoteFiles(vaultRoot: string, files: NoteFile[]): number {
  for (const file of files) {
    writeNoteFile(vaultRoot, file)
  }
  return files.length
}
