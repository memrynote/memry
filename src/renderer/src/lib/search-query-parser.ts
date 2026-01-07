/**
 * Search Query Parser
 *
 * Parses search queries with operator syntax into structured filters.
 *
 * Supported operators:
 * - path:value or path:"quoted value" - Match note path
 * - file:value or file:"quoted value" - Match filename
 * - tag:value or tag:#value - Filter by tag
 * - [property]:value - Filter by frontmatter property
 *
 * @example
 * ```typescript
 * parseSearchQuery('meeting notes tag:work path:/projects')
 * // Returns:
 * // {
 * //   text: 'meeting notes',
 * //   operators: { tags: ['work'], path: '/projects' },
 * //   raw: 'meeting notes tag:work path:/projects'
 * // }
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface PropertyFilter {
  name: string
  value: string
}

export interface SearchOperators {
  path?: string
  file?: string
  tags?: string[]
  properties?: PropertyFilter[]
}

export interface ParsedSearchQuery {
  /** Text query with operators removed (for FTS search) */
  text: string
  /** Extracted operators */
  operators: SearchOperators
  /** Original query string */
  raw: string
}

// ============================================================================
// Parser Implementation
// ============================================================================

/**
 * Regex patterns for operator extraction
 *
 * Operators can have:
 * - Unquoted values: path:notes/folder
 * - Double-quoted values: path:"my folder/notes"
 * - Single-quoted values: path:'my folder/notes'
 */
const OPERATOR_PATTERNS = {
  // path:value or path:"value" or path:'value'
  path: /path:(?:"([^"]+)"|'([^']+)'|(\S+))/gi,

  // file:value or file:"value" or file:'value'
  file: /file:(?:"([^"]+)"|'([^']+)'|(\S+))/gi,

  // tag:value or tag:#value or tag:"value"
  tag: /tag:(?:#?(?:"([^"]+)"|'([^']+)'|(\S+)))/gi,

  // [property]:value or [property]:"value"
  property: /\[([^\]]+)\]:(?:"([^"]+)"|'([^']+)'|(\S+))/gi
}

/**
 * Extract value from regex match groups
 * Groups are: quoted double, quoted single, unquoted
 */
function extractValue(match: RegExpMatchArray, startIndex: number): string {
  return match[startIndex] || match[startIndex + 1] || match[startIndex + 2] || ''
}

/**
 * Parse a search query string into structured components.
 *
 * @param query - Raw search query string
 * @returns Parsed query with text and operators separated
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  if (!query || typeof query !== 'string') {
    return {
      text: '',
      operators: {},
      raw: query || ''
    }
  }

  const operators: SearchOperators = {}
  let remainingQuery = query

  const pathMatches = Array.from(query.matchAll(OPERATOR_PATTERNS.path))
  if (pathMatches.length > 0) {
    const match = pathMatches[0]
    operators.path = extractValue(match, 1)
    remainingQuery = remainingQuery.replace(match[0], '')
  }

  const fileMatches = Array.from(query.matchAll(OPERATOR_PATTERNS.file))
  if (fileMatches.length > 0) {
    const match = fileMatches[0]
    operators.file = extractValue(match, 1)
    remainingQuery = remainingQuery.replace(match[0], '')
  }

  const tagMatches = Array.from(query.matchAll(OPERATOR_PATTERNS.tag))
  if (tagMatches.length > 0) {
    operators.tags = tagMatches.map((match) => {
      remainingQuery = remainingQuery.replace(match[0], '')
      const tagValue = extractValue(match, 1)
      const normalizedTag = tagValue.startsWith('#') ? tagValue.slice(1) : tagValue
      return normalizedTag.toLowerCase()
    })
  }

  const propertyMatches = Array.from(query.matchAll(OPERATOR_PATTERNS.property))
  if (propertyMatches.length > 0) {
    operators.properties = propertyMatches.map((match) => {
      remainingQuery = remainingQuery.replace(match[0], '')
      const propertyName = match[1]
      const propertyValue = match[2] || match[3] || match[4] || ''
      return { name: propertyName, value: propertyValue }
    })
  }

  const normalizedWhitespace = remainingQuery.replace(/\s+/g, ' ')
  const text = normalizedWhitespace.trim()

  return {
    text,
    operators,
    raw: query
  }
}

export function hasOperators(query: string): boolean {
  if (!query) return false

  return (
    /path:/.test(query) || /file:/.test(query) || /tag:/.test(query) || /\[[^\]]+\]:/.test(query)
  )
}

/**
 * Get list of operator prefixes for autocomplete/highlighting
 */
export function getOperatorPrefixes(): string[] {
  return ['path:', 'file:', 'tag:', '[']
}

/**
 * Format a ParsedSearchQuery back into a query string
 */
export function formatSearchQuery(parsed: ParsedSearchQuery): string {
  const parts: string[] = []

  if (parsed.text) {
    parts.push(parsed.text)
  }

  if (parsed.operators.path) {
    const value = parsed.operators.path.includes(' ')
      ? `"${parsed.operators.path}"`
      : parsed.operators.path
    parts.push(`path:${value}`)
  }

  if (parsed.operators.file) {
    const value = parsed.operators.file.includes(' ')
      ? `"${parsed.operators.file}"`
      : parsed.operators.file
    parts.push(`file:${value}`)
  }

  if (parsed.operators.tags) {
    for (const tag of parsed.operators.tags) {
      parts.push(`tag:${tag}`)
    }
  }

  if (parsed.operators.properties) {
    for (const prop of parsed.operators.properties) {
      const value = prop.value.includes(' ') ? `"${prop.value}"` : prop.value
      parts.push(`[${prop.name}]:${value}`)
    }
  }

  return parts.join(' ')
}
