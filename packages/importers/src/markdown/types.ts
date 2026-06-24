/**
 * Types for the Markdown import transform.
 *
 * Pure data shapes — no electron / fs / db dependencies.
 */

/** Parsed frontmatter + body for one markdown file. */
export interface ParsedMarkdown {
  /** Frontmatter title (lifted from data.title), if present. */
  title?: string
  /** Tags lifted from data.tags (string or string[]). */
  tags: string[]
  /** Remaining frontmatter keys, excluding title and tags. */
  properties: Record<string, unknown>
  /** Body text below the frontmatter block. */
  body: string
}

/** A file descriptor given as input to mapFiles. */
export interface FileDescriptor {
  /** Path relative to the selection root (e.g. 'notes/foo.md' or 'foo.md'). */
  relPath: string
  /** Absolute path on disk. */
  absPath: string
}

/** One note entry in the import plan. */
export interface NotePlan {
  absPath: string
  /** Note title derived from filename (without extension). */
  title: string
  /** Vault folder path, e.g. 'Markdown' or 'Markdown/notes'. */
  vaultFolder: string
}

/** Result of mapFiles. */
export interface MarkdownImportPlan {
  notes: NotePlan[]
}
