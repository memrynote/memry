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
  return stripMarkup(content).replace(/\s+/g, ' ').trim().slice(0, 180)
}

function stripMarkup(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '') // memry block/colors/file markers + any HTML comment
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // wiki link w/ alias → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wiki link → target
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '')) // fenced code → inner text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // image → alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link → text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered markers
    .replace(/[*_~]{1,3}/g, '') // emphasis/strike
}
