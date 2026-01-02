/**
 * Summary Evaluator for Column Summaries
 *
 * Computes aggregated values for table columns.
 * Supports: sum, average, min, max, count, countBy, countUnique, custom
 *
 * @module lib/summary-evaluator
 */

import type { NoteWithProperties, SummaryConfig } from '@shared/contracts/folder-view-api'
import { evaluateFormula } from './expression-evaluator'

// ============================================================================
// Types
// ============================================================================

export type SummaryType = SummaryConfig['type']

export type SummaryResult = number | string | null

// ============================================================================
// Column Value Extraction
// ============================================================================

/**
 * Get all values for a column from the notes array.
 * Handles built-in columns, properties, and formula columns.
 */
export function getColumnValues(
  notes: NoteWithProperties[],
  columnId: string,
  formulas?: Record<string, string>
): unknown[] {
  return notes.map((note) => {
    // Formula columns
    if (columnId.startsWith('formula.')) {
      const formulaName = columnId.slice(8) // Remove 'formula.' prefix
      const expression = formulas?.[formulaName]
      if (!expression) return null
      return evaluateFormula(expression, note)
    }

    // Built-in columns
    switch (columnId) {
      case 'title':
        return note.title
      case 'folder':
        return note.folder
      case 'tags':
        return note.tags
      case 'created':
        return note.created
      case 'modified':
        return note.modified
      case 'wordCount':
        return note.wordCount
      default:
        // Property columns
        return note.properties[columnId] ?? null
    }
  })
}

// ============================================================================
// Summary Computation
// ============================================================================

/**
 * Compute a summary value based on the summary type.
 */
export function computeSummary(values: unknown[], config: SummaryConfig): SummaryResult {
  const { type, expression } = config

  switch (type) {
    case 'sum':
      return computeSum(values)

    case 'average':
      return computeAverage(values)

    case 'min':
      return computeMin(values)

    case 'max':
      return computeMax(values)

    case 'count':
      return computeCount(values)

    case 'countBy':
      return computeCountBy(values)

    case 'countUnique':
      return computeCountUnique(values)

    case 'custom':
      return computeCustom(values, expression)

    default:
      return null
  }
}

/**
 * Sum all numeric values.
 */
function computeSum(values: unknown[]): number {
  let sum = 0
  for (const value of values) {
    if (typeof value === 'number' && !isNaN(value)) {
      sum += value
    } else if (typeof value === 'string') {
      const num = parseFloat(value)
      if (!isNaN(num)) {
        sum += num
      }
    }
  }
  return sum
}

/**
 * Compute average of numeric values.
 */
function computeAverage(values: unknown[]): number | null {
  const numbers: number[] = []
  for (const value of values) {
    if (typeof value === 'number' && !isNaN(value)) {
      numbers.push(value)
    } else if (typeof value === 'string') {
      const num = parseFloat(value)
      if (!isNaN(num)) {
        numbers.push(num)
      }
    }
  }
  if (numbers.length === 0) return null
  return numbers.reduce((a, b) => a + b, 0) / numbers.length
}

/**
 * Find minimum value (works for numbers and dates).
 */
function computeMin(values: unknown[]): number | string | null {
  let min: number | Date | null = null

  for (const value of values) {
    if (value === null || value === undefined) continue

    // Try as number
    if (typeof value === 'number' && !isNaN(value)) {
      if (min === null || value < (min as number)) {
        min = value
      }
      continue
    }

    // Try as date string
    if (typeof value === 'string') {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        if (min === null || date < (min as Date)) {
          min = date
        }
        continue
      }

      // Try as numeric string
      const num = parseFloat(value)
      if (!isNaN(num)) {
        if (min === null || num < (min as number)) {
          min = num
        }
      }
    }
  }

  if (min === null) return null
  if (min instanceof Date) return min.toISOString()
  return min
}

/**
 * Find maximum value (works for numbers and dates).
 */
function computeMax(values: unknown[]): number | string | null {
  let max: number | Date | null = null

  for (const value of values) {
    if (value === null || value === undefined) continue

    // Try as number
    if (typeof value === 'number' && !isNaN(value)) {
      if (max === null || value > (max as number)) {
        max = value
      }
      continue
    }

    // Try as date string
    if (typeof value === 'string') {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        if (max === null || date > (max as Date)) {
          max = date
        }
        continue
      }

      // Try as numeric string
      const num = parseFloat(value)
      if (!isNaN(num)) {
        if (max === null || num > (max as number)) {
          max = num
        }
      }
    }
  }

  if (max === null) return null
  if (max instanceof Date) return max.toISOString()
  return max
}

/**
 * Count non-null, non-empty values.
 */
function computeCount(values: unknown[]): number {
  let count = 0
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') {
      // Handle arrays (like tags)
      if (Array.isArray(value)) {
        if (value.length > 0) count++
      } else {
        count++
      }
    }
  }
  return count
}

/**
 * Group by value and return formatted string.
 * Example: "Active: 5, Done: 3, Draft: 2"
 */
function computeCountBy(values: unknown[]): string {
  const counts = new Map<string, number>()

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue

    // Handle arrays (flatten them)
    const items = Array.isArray(value) ? value : [value]

    for (const item of items) {
      const key = String(item)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  if (counts.size === 0) return ''

  // Sort by count (descending), then alphabetically
  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })

  // Format: "value: count, ..."
  // Limit to top 5 to avoid overflow
  const top = sorted.slice(0, 5)
  const result = top.map(([key, count]) => `${key}: ${count}`).join(', ')

  if (sorted.length > 5) {
    return result + ` (+${sorted.length - 5} more)`
  }

  return result
}

/**
 * Count unique values.
 */
function computeCountUnique(values: unknown[]): number {
  const unique = new Set<string>()

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue

    // Handle arrays (flatten them)
    const items = Array.isArray(value) ? value : [value]

    for (const item of items) {
      unique.add(String(item))
    }
  }

  return unique.size
}

/**
 * Compute custom summary using expression.
 * The expression has access to a `values` array.
 */
function computeCustom(values: unknown[], expression?: string): SummaryResult {
  if (!expression) return null

  try {
    // Create a mock note with 'values' as a property for expression evaluation
    // This is a simple approach - for more complex needs, we'd need a custom evaluator
    const numericValues = values.filter((v): v is number => typeof v === 'number' && !isNaN(v))

    // Simple expression support for common aggregate patterns
    const expr = expression.toLowerCase().trim()

    if (expr === 'sum(values)' || expr === 'sum') {
      return computeSum(values)
    }
    if (
      expr === 'avg(values)' ||
      expr === 'average(values)' ||
      expr === 'avg' ||
      expr === 'average'
    ) {
      return computeAverage(values)
    }
    if (expr === 'min(values)' || expr === 'min') {
      return computeMin(values)
    }
    if (expr === 'max(values)' || expr === 'max') {
      return computeMax(values)
    }
    if (expr === 'count(values)' || expr === 'count') {
      return computeCount(values)
    }
    if (expr === 'countunique(values)' || expr === 'countunique') {
      return computeCountUnique(values)
    }

    // Handle simple arithmetic on sum
    if (expr.includes('sum') && numericValues.length > 0) {
      const sum = computeSum(values)
      // e.g., "sum * 1.1" for 10% markup
      const match = expr.match(/sum\s*\*\s*([\d.]+)/)
      if (match) {
        return sum * parseFloat(match[1])
      }
    }

    // Fallback: return count
    return computeCount(values)
  } catch (err) {
    console.warn('Custom summary evaluation error:', err)
    return null
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a summary result for display.
 */
export function formatSummaryValue(result: SummaryResult, config: SummaryConfig): string {
  if (result === null || result === undefined) return '—'

  const { type } = config

  // String results (like countBy) - return as-is
  if (typeof result === 'string') {
    // Check if it's an ISO date string for min/max on date columns
    if ((type === 'min' || type === 'max') && result.includes('T')) {
      try {
        const date = new Date(result)
        if (!isNaN(date.getTime())) {
          return formatDate(date)
        }
      } catch {
        // Not a date, return as-is
      }
    }
    return result
  }

  // Number results
  if (typeof result === 'number') {
    // Format based on summary type
    if (type === 'count' || type === 'countUnique') {
      return result.toLocaleString()
    }

    if (type === 'average') {
      // Show 1-2 decimal places for averages
      return result.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      })
    }

    // Sum, min, max - format with locale
    return result.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })
  }

  return String(result)
}

/**
 * Format a date for display.
 */
function formatDate(date: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const diffDays = Math.floor((today.getTime() - dateOnly.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays === -1) return 'Tomorrow'

  // Within this year, show "Dec 25"
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // Different year, show "Dec 25, 2024"
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ============================================================================
// Summary Type Helpers
// ============================================================================

/**
 * Get available summary types for a column type.
 */
export function getSummaryTypesForColumn(columnType: string): SummaryType[] {
  switch (columnType) {
    case 'number':
      return ['sum', 'average', 'min', 'max', 'count', 'countUnique']

    case 'date':
      return ['count', 'min', 'max']

    case 'checkbox':
      return ['count', 'countBy']

    case 'select':
      return ['count', 'countBy', 'countUnique']

    case 'multiselect':
    case 'tags':
      return ['count', 'countBy', 'countUnique']

    case 'text':
    case 'url':
    default:
      return ['count', 'countUnique']
  }
}

/**
 * Get display name for a summary type.
 */
export function getSummaryTypeLabel(type: SummaryType): string {
  switch (type) {
    case 'sum':
      return 'Sum'
    case 'average':
      return 'Average'
    case 'min':
      return 'Min'
    case 'max':
      return 'Max'
    case 'count':
      return 'Count'
    case 'countBy':
      return 'Count by value'
    case 'countUnique':
      return 'Unique'
    case 'custom':
      return 'Custom'
    default:
      return type
  }
}

/**
 * Get icon/symbol for a summary type.
 */
export function getSummaryTypeSymbol(type: SummaryType): string {
  switch (type) {
    case 'sum':
      return 'Σ'
    case 'average':
      return 'μ'
    case 'min':
      return '↓'
    case 'max':
      return '↑'
    case 'count':
      return '#'
    case 'countBy':
      return '⊞'
    case 'countUnique':
      return '∪'
    case 'custom':
      return 'ƒ'
    default:
      return '?'
  }
}

export default computeSummary
