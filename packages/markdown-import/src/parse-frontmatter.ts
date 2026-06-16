/**
 * Parse YAML frontmatter from a markdown file.
 *
 * Uses gray-matter to split the leading --- block from the body.
 * Lifts `title` and `tags` out of the data object; remaining keys
 * become `properties`.
 */

import matter from 'gray-matter'
import type { ParsedMarkdown } from './types.ts'

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string')
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
  return []
}

export function parseFrontmatter(source: string): ParsedMarkdown {
  const { data, content } = matter(source)

  const title = typeof data['title'] === 'string' ? data['title'] : undefined
  const tags = normalizeTags(data['tags'])

  const properties: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(data)) {
    if (key === 'title' || key === 'tags') continue
    properties[key] = val
  }

  return { title, tags, properties, body: content }
}
