/**
 * Filter Evaluator
 *
 * Pure logic module for evaluating FilterExpression against notes.
 * Supports AND/OR/NOT nesting and various operators per property type.
 *
 * @module filter-evaluator
 */

import type { NoteWithProperties, FilterExpression } from '@shared/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'

export interface Operator {
  value: string
  label: string
  /** Whether this operator requires a value input */
  needsValue: boolean
}

export interface ParsedCondition {
  property: string
  operator: string
  value: unknown
}

// ============================================================================
// Operator Definitions
// ============================================================================

const TEXT_OPERATORS: Operator[] = [
  { value: '==', label: 'is', needsValue: true },
  { value: '!=', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'notContains', label: 'does not contain', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'endsWith', label: 'ends with', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false }
]

const NUMBER_OPERATORS: Operator[] = [
  { value: '==', label: 'equals', needsValue: true },
  { value: '!=', label: 'does not equal', needsValue: true },
  { value: '>', label: 'greater than', needsValue: true },
  { value: '>=', label: 'greater than or equal', needsValue: true },
  { value: '<', label: 'less than', needsValue: true },
  { value: '<=', label: 'less than or equal', needsValue: true }
]

const DATE_OPERATORS: Operator[] = [
  { value: '==', label: 'is', needsValue: true },
  { value: '!=', label: 'is not', needsValue: true },
  { value: 'before', label: 'is before', needsValue: true },
  { value: 'after', label: 'is after', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false }
]

const CHECKBOX_OPERATORS: Operator[] = [
  { value: 'isChecked', label: 'is checked', needsValue: false },
  { value: 'isUnchecked', label: 'is unchecked', needsValue: false }
]

const SELECT_OPERATORS: Operator[] = [
  { value: '==', label: 'is', needsValue: true },
  { value: '!=', label: 'is not', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false }
]

const MULTISELECT_OPERATORS: Operator[] = [
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'notContains', label: 'does not contain', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false }
]

const URL_OPERATORS: Operator[] = [
  { value: '==', label: 'is', needsValue: true },
  { value: '!=', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false }
]

const RATING_OPERATORS: Operator[] = [
  { value: '==', label: 'equals', needsValue: true },
  { value: '!=', label: 'does not equal', needsValue: true },
  { value: '>=', label: 'at least', needsValue: true },
  { value: '<=', label: 'at most', needsValue: true }
]

// ============================================================================
// Operator Utilities
// ============================================================================

/**
 * Get available operators for a property type.
 */
export function getOperatorsForType(type: PropertyType): Operator[] {
  switch (type) {
    case 'text':
      return TEXT_OPERATORS
    case 'number':
      return NUMBER_OPERATORS
    case 'date':
      return DATE_OPERATORS
    case 'checkbox':
      return CHECKBOX_OPERATORS
    case 'select':
      return SELECT_OPERATORS
    case 'multiselect':
      return MULTISELECT_OPERATORS
    case 'url':
      return URL_OPERATORS
    case 'rating':
      return RATING_OPERATORS
    default:
      return TEXT_OPERATORS
  }
}

/**
 * Get the default operator for a property type.
 */
export function getDefaultOperator(type: PropertyType): string {
  switch (type) {
    case 'checkbox':
      return 'isChecked'
    case 'multiselect':
      return 'contains'
    default:
      return '=='
  }
}

// ============================================================================
// Expression Parsing
// ============================================================================

/**
 * Parse a simple expression string into components.
 *
 * Supported formats:
 * - `property == "value"` (quoted string)
 * - `property == value` (unquoted)
 * - `property >= 5` (number)
 * - `property contains "text"`
 * - `property isEmpty`
 *
 * @param expr - Expression string like 'status == "done"'
 * @returns Parsed condition or null if parsing fails
 */
export function parseExpression(expr: string): ParsedCondition | null {
  if (!expr || typeof expr !== 'string') {
    return null
  }

  const trimmed = expr.trim()

  // Try to match operators in order of specificity (longer operators first)
  const operators = [
    '>=',
    '<=',
    '!=',
    '==',
    '>',
    '<',
    'notContains',
    'contains',
    'startsWith',
    'endsWith',
    'isNotEmpty',
    'isEmpty',
    'isChecked',
    'isUnchecked',
    'before',
    'after'
  ]

  for (const op of operators) {
    const opIndex = trimmed.indexOf(` ${op}`)
    if (opIndex === -1) continue

    const property = trimmed.slice(0, opIndex).trim()
    const afterOp = trimmed.slice(opIndex + op.length + 1).trim()

    // Operators that don't need values
    if (['isEmpty', 'isNotEmpty', 'isChecked', 'isUnchecked'].includes(op)) {
      return { property, operator: op, value: null }
    }

    // Parse the value
    const value = parseValue(afterOp)
    return { property, operator: op, value }
  }

  return null
}

/**
 * Parse a value string, handling quoted strings and numbers.
 */
function parseValue(valueStr: string): unknown {
  const trimmed = valueStr.trim()

  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  // Boolean
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  // Number
  const num = Number(trimmed)
  if (!isNaN(num)) return num

  // Unquoted string
  return trimmed
}

/**
 * Serialize a condition back to expression string.
 */
export function serializeCondition(condition: ParsedCondition): string {
  const { property, operator, value } = condition

  // Operators that don't need values
  if (['isEmpty', 'isNotEmpty', 'isChecked', 'isUnchecked'].includes(operator)) {
    return `${property} ${operator}`
  }

  // Format value
  let valueStr: string
  if (typeof value === 'string') {
    valueStr = `"${value}"`
  } else if (value === null || value === undefined) {
    valueStr = '""'
  } else {
    valueStr = String(value)
  }

  return `${property} ${operator} ${valueStr}`
}

// ============================================================================
// Filter Evaluation
// ============================================================================

/**
 * Evaluate a filter expression against a note.
 *
 * @param note - The note with properties to evaluate
 * @param filter - The filter expression (string, AND, OR, or NOT)
 * @returns True if the note matches the filter
 */
export function evaluateFilter(note: NoteWithProperties, filter: FilterExpression): boolean {
  // Handle null/undefined filter (matches all)
  if (!filter) {
    return true
  }

  // Simple string expression
  if (typeof filter === 'string') {
    const parsed = parseExpression(filter)
    if (!parsed) {
      console.warn('[filter-evaluator] Failed to parse expression:', filter)
      return true // Invalid filter matches all
    }
    return evaluateCondition(note, parsed)
  }

  // AND group
  if ('and' in filter) {
    return filter.and.every((subFilter) => evaluateFilter(note, subFilter))
  }

  // OR group
  if ('or' in filter) {
    return filter.or.some((subFilter) => evaluateFilter(note, subFilter))
  }

  // NOT
  if ('not' in filter) {
    return !evaluateFilter(note, filter.not)
  }

  // Unknown filter type
  console.warn('[filter-evaluator] Unknown filter type:', filter)
  return true
}

/**
 * Evaluate a single condition against a note.
 */
function evaluateCondition(note: NoteWithProperties, condition: ParsedCondition): boolean {
  const { property, operator, value } = condition

  // Get the actual value from the note
  const noteValue = getNotePropertyValue(note, property)

  // Evaluate based on operator
  return evaluateOperator(noteValue, operator, value)
}

/**
 * Get a property value from a note, handling built-in and custom properties.
 */
function getNotePropertyValue(note: NoteWithProperties, property: string): unknown {
  // Built-in properties
  switch (property) {
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
    case 'emoji':
      return note.emoji
    case 'path':
      return note.path
    default:
      // Custom property
      return note.properties[property]
  }
}

/**
 * Evaluate an operator against actual and expected values.
 * All string comparisons are case-insensitive.
 */
function evaluateOperator(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    // Equality
    case '==':
      return isEqual(actual, expected)
    case '!=':
      return !isEqual(actual, expected)

    // Comparison (numbers and dates)
    case '>':
      return compareValues(actual, expected) > 0
    case '>=':
      return compareValues(actual, expected) >= 0
    case '<':
      return compareValues(actual, expected) < 0
    case '<=':
      return compareValues(actual, expected) <= 0

    // Date-specific
    case 'before':
      return compareDates(actual, expected) < 0
    case 'after':
      return compareDates(actual, expected) > 0

    // String operations (case-insensitive)
    case 'contains':
      return containsValue(actual, expected)
    case 'notContains':
      return !containsValue(actual, expected)
    case 'startsWith':
      return startsWithValue(actual, expected)
    case 'endsWith':
      return endsWithValue(actual, expected)

    // Empty checks
    case 'isEmpty':
      return isEmpty(actual)
    case 'isNotEmpty':
      return !isEmpty(actual)

    // Checkbox
    case 'isChecked':
      return actual === true
    case 'isUnchecked':
      return actual === false || actual === null || actual === undefined

    default:
      console.warn('[filter-evaluator] Unknown operator:', operator)
      return true
  }
}

// ============================================================================
// Comparison Helpers
// ============================================================================

/**
 * Check equality, handling strings case-insensitively.
 */
function isEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase()
  }
  return actual === expected
}

/**
 * Compare values for ordering (numbers, dates).
 */
function compareValues(actual: unknown, expected: unknown): number {
  const numActual = toNumber(actual)
  const numExpected = toNumber(expected)

  if (numActual !== null && numExpected !== null) {
    return numActual - numExpected
  }

  // Try date comparison
  return compareDates(actual, expected)
}

/**
 * Compare two date values.
 */
function compareDates(actual: unknown, expected: unknown): number {
  const dateActual = toDate(actual)
  const dateExpected = toDate(expected)

  if (!dateActual || !dateExpected) return 0

  return dateActual.getTime() - dateExpected.getTime()
}

/**
 * Check if actual contains expected (case-insensitive).
 * Works for strings and arrays.
 */
function containsValue(actual: unknown, expected: unknown): boolean {
  // Array contains
  if (Array.isArray(actual)) {
    const expectedStr = String(expected).toLowerCase()
    return actual.some((item) => String(item).toLowerCase() === expectedStr)
  }

  // String contains
  if (typeof actual === 'string' && expected != null) {
    return actual.toLowerCase().includes(String(expected).toLowerCase())
  }

  return false
}

/**
 * Check if string starts with value (case-insensitive).
 */
function startsWithValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== 'string' || expected == null) return false
  return actual.toLowerCase().startsWith(String(expected).toLowerCase())
}

/**
 * Check if string ends with value (case-insensitive).
 */
function endsWithValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== 'string' || expected == null) return false
  return actual.toLowerCase().endsWith(String(expected).toLowerCase())
}

/**
 * Check if a value is empty (null, undefined, empty string, empty array).
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Convert value to number, returning null if not possible.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const num = Number(value)
    return isNaN(num) ? null : num
  }
  return null
}

/**
 * Convert value to Date, returning null if not possible.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return isNaN(date.getTime()) ? null : date
  }
  return null
}

// ============================================================================
// Filter Utilities
// ============================================================================

/**
 * Count the total number of conditions in a filter expression.
 * Used for displaying the badge count.
 */
export function countFilterConditions(filter: FilterExpression | undefined): number {
  if (!filter) return 0

  if (typeof filter === 'string') {
    return 1
  }

  if ('and' in filter) {
    return filter.and.reduce((sum, sub) => sum + countFilterConditions(sub), 0)
  }

  if ('or' in filter) {
    return filter.or.reduce((sum, sub) => sum + countFilterConditions(sub), 0)
  }

  if ('not' in filter) {
    return countFilterConditions(filter.not)
  }

  return 0
}

/**
 * Check if a filter expression is empty (no conditions).
 */
export function isFilterEmpty(filter: FilterExpression | undefined): boolean {
  return countFilterConditions(filter) === 0
}

/**
 * Create a simple filter expression from a condition.
 */
export function createSimpleFilter(property: string, operator: string, value: unknown): string {
  return serializeCondition({ property, operator, value })
}

/**
 * Combine multiple filters with AND logic.
 */
export function combineFiltersAnd(filters: FilterExpression[]): FilterExpression | undefined {
  const nonEmpty = filters.filter((f) => !isFilterEmpty(f))
  if (nonEmpty.length === 0) return undefined
  if (nonEmpty.length === 1) return nonEmpty[0]
  return { and: nonEmpty }
}

/**
 * Combine multiple filters with OR logic.
 */
export function combineFiltersOr(filters: FilterExpression[]): FilterExpression | undefined {
  const nonEmpty = filters.filter((f) => !isFilterEmpty(f))
  if (nonEmpty.length === 0) return undefined
  if (nonEmpty.length === 1) return nonEmpty[0]
  return { or: nonEmpty }
}

export default {
  evaluateFilter,
  parseExpression,
  serializeCondition,
  getOperatorsForType,
  getDefaultOperator,
  countFilterConditions,
  isFilterEmpty,
  createSimpleFilter,
  combineFiltersAnd,
  combineFiltersOr
}
