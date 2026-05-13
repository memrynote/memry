import matter from 'gray-matter'

export interface ParsedMarkdownNote {
  frontmatter: Record<string, unknown>
  content: string
}

export function parseMarkdownNote(raw: string): ParsedMarkdownNote {
  const parsed = matter(raw)
  return {
    frontmatter: parsed.data,
    content: parsed.content.trim()
  }
}

export function writeMarkdownNote(frontmatter: Record<string, unknown>, content: string): string {
  return matter.stringify(content.trim(), frontmatter).trimEnd()
}

export function wordCount(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean)
  return words.length
}

export function snippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 180)
}
