/**
 * Tag Utility Functions
 * Helper functions for tag functionality
 */

/**
 * Validate tag name
 * Tags must:
 * - Start with letter or number
 * - Contain only letters, numbers, hyphens, underscores
 * - No spaces or special punctuation
 */
export function isValidTagName(name: string): boolean {
  if (!name || name.length === 0) return false

  // Must start with letter or number
  if (!/^[a-zA-Z0-9]/.test(name)) return false

  // Can only contain letters, numbers, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false

  return true
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
  const tagRegex = /#([a-zA-Z0-9_-]+)/g
  const matches = text.matchAll(tagRegex)
  const tags = Array.from(matches, (m) => m[1])

  // Return unique tags
  return Array.from(new Set(tags))
}

/**
 * Sanitize tag input (remove invalid characters)
 */
export function sanitizeTagInput(input: string): string {
  // Remove # prefix
  let sanitized = input.replace(/^#/, '')

  // Remove spaces and invalid characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '')

  return sanitized
}

/**
 * Check if character ends a tag
 * Tags end on space, punctuation, or line break
 */
export function isTagTerminator(char: string): boolean {
  return /[\s,.!?;:()[\]{}]/.test(char)
}
