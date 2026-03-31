/**
 * Tag Utility Functions
 * Helper functions for tag functionality
 */

/**
 * Validate tag name
 * Tags must:
 * - Start with letter or number
 * - Contain only letters, numbers, hyphens, underscores
 * - Optionally contain / for hierarchical sub-tags (e.g. movies/oscar)
 * - No leading/trailing slash, no double slashes, no empty segments
 */
export function isValidTagName(name: string): boolean {
  if (!name || name.length === 0) return false
  if (!/^[a-zA-Z0-9]/.test(name)) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/.test(name)
}

/**
 * Normalize tag name
 * - Trim whitespace
 * - Convert to lowercase (for storage)
 * - Remove # prefix if present
 */
export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/^#/, '')
}

/**
 * Format tag for display with # prefix
 */
export function formatTagDisplay(name: string): string {
  return `#${name}`
}

/**
 * Extract tags from text
 * Finds all #tag patterns in text
 */
export function extractTagsFromText(text: string): string[] {
  const tagRegex = /#([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g
  const matches = text.matchAll(tagRegex)
  const tags = Array.from(matches, (m) => m[1])

  return Array.from(new Set(tags))
}

/**
 * Sanitize tag input (remove invalid characters)
 */
export function sanitizeTagInput(input: string): string {
  let sanitized = input.replace(/^#/, '')
  sanitized = sanitized.replace(/[^a-zA-Z0-9_\-/]/g, '')
  sanitized = sanitized.replace(/\/{2,}/g, '/')
  sanitized = sanitized.replace(/^\/|\/$/g, '')
  return sanitized
}

/**
 * Check if character ends a tag
 * Tags end on space, punctuation, or line break
 */
export function isTagTerminator(char: string): boolean {
  return /[\s,.!?;:()[\]{}]/.test(char)
}

export function getTagSegments(tag: string): string[] {
  return tag.split('/')
}

export function getParentTag(tag: string): string | null {
  const idx = tag.lastIndexOf('/')
  return idx === -1 ? null : tag.slice(0, idx)
}

export function getTagDepth(tag: string): number {
  return tag.split('/').length - 1
}

export function getTagLeaf(tag: string): string {
  const segments = tag.split('/')
  return segments[segments.length - 1]
}

export function isDescendantOf(tag: string, ancestor: string): boolean {
  return tag.startsWith(ancestor + '/')
}

export function getAncestorTags(tag: string): string[] {
  const segments = tag.split('/')
  const ancestors: string[] = []
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join('/'))
  }
  return ancestors
}
