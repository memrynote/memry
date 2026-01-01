/**
 * Expression Evaluator for Formula Columns
 *
 * Evaluates parsed AST nodes against a note context.
 * Provides built-in functions for date manipulation, string operations, etc.
 *
 * @module lib/expression-evaluator
 */

import { parseExpression, type ASTNode, ParseError } from './expression-parser'
import type { NoteWithProperties } from '@shared/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

/**
 * Context for formula evaluation.
 */
export interface FormulaContext {
  /** The note being evaluated */
  note: NoteWithProperties
}

/**
 * Result of formula evaluation.
 */
export type FormulaResult = string | number | boolean | Date | null | unknown[]

// ============================================================================
// Built-in Functions
// ============================================================================

type BuiltInFunction = (args: unknown[], context: FormulaContext) => unknown

/**
 * Parse a value as a Date, handling various formats.
 */
function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!isNaN(date.getTime())) return date
  }
  if (typeof value === 'number') {
    return new Date(value)
  }
  return null
}

/**
 * Get date difference in specified units.
 */
function getDateDiff(d1: Date, d2: Date, unit: string): number {
  const diffMs = d1.getTime() - d2.getTime()

  switch (unit.toLowerCase()) {
    case 'milliseconds':
    case 'ms':
      return diffMs
    case 'seconds':
    case 's':
      return Math.floor(diffMs / 1000)
    case 'minutes':
    case 'm':
      return Math.floor(diffMs / (1000 * 60))
    case 'hours':
    case 'h':
      return Math.floor(diffMs / (1000 * 60 * 60))
    case 'days':
    case 'd':
      return Math.floor(diffMs / (1000 * 60 * 60 * 24))
    case 'weeks':
    case 'w':
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7))
    case 'months':
      // Approximate months (30 days)
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30))
    case 'years':
    case 'y':
      // Approximate years (365 days)
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365))
    default:
      return Math.floor(diffMs / (1000 * 60 * 60 * 24)) // default to days
  }
}

/**
 * Built-in functions available in formulas.
 */
const BUILT_IN_FUNCTIONS: Record<string, BuiltInFunction> = {
  // Date functions
  today: () => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  },

  now: () => new Date(),

  dateDiff: (args) => {
    if (args.length < 2) return null
    const d1 = parseDate(args[0])
    const d2 = parseDate(args[1])
    if (!d1 || !d2) return null
    const unit = typeof args[2] === 'string' ? args[2] : 'days'
    return getDateDiff(d1, d2, unit)
  },

  dateAdd: (args) => {
    if (args.length < 2) return null
    const date = parseDate(args[0])
    const amount = typeof args[1] === 'number' ? args[1] : null
    if (!date || amount === null) return null
    const unit = typeof args[2] === 'string' ? args[2] : 'days'

    const result = new Date(date)
    switch (unit.toLowerCase()) {
      case 'days':
      case 'd':
        result.setDate(result.getDate() + amount)
        break
      case 'weeks':
      case 'w':
        result.setDate(result.getDate() + amount * 7)
        break
      case 'months':
        result.setMonth(result.getMonth() + amount)
        break
      case 'years':
      case 'y':
        result.setFullYear(result.getFullYear() + amount)
        break
      case 'hours':
      case 'h':
        result.setHours(result.getHours() + amount)
        break
      case 'minutes':
      case 'm':
        result.setMinutes(result.getMinutes() + amount)
        break
      default:
        result.setDate(result.getDate() + amount)
    }
    return result
  },

  formatDate: (args) => {
    if (args.length < 1) return null
    const date = parseDate(args[0])
    if (!date) return null
    const format = typeof args[1] === 'string' ? args[1] : 'yyyy-MM-dd'

    // Simple format implementation
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return format
      .replace('yyyy', String(year))
      .replace('MM', month)
      .replace('dd', day)
      .replace('HH', hours)
      .replace('mm', minutes)
      .replace('ss', seconds)
  },

  // Conditional functions
  if: (args) => {
    if (args.length < 2) return null
    const condition = args[0]
    const trueValue = args[1]
    const falseValue = args.length > 2 ? args[2] : null
    return condition ? trueValue : falseValue
  },

  coalesce: (args) => {
    for (const arg of args) {
      if (arg !== null && arg !== undefined && arg !== '') {
        return arg
      }
    }
    return null
  },

  // String functions
  concat: (args) => {
    return args.map((a) => (a === null || a === undefined ? '' : String(a))).join('')
  },

  lower: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'string' ? args[0].toLowerCase() : null
  },

  upper: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'string' ? args[0].toUpperCase() : null
  },

  trim: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'string' ? args[0].trim() : null
  },

  substring: (args) => {
    if (args.length < 2) return null
    const str = typeof args[0] === 'string' ? args[0] : null
    const start = typeof args[1] === 'number' ? args[1] : null
    if (str === null || start === null) return null
    const end = typeof args[2] === 'number' ? args[2] : undefined
    return str.substring(start, end)
  },

  replace: (args) => {
    if (args.length < 3) return null
    const str = typeof args[0] === 'string' ? args[0] : null
    const search = typeof args[1] === 'string' ? args[1] : null
    const replacement = typeof args[2] === 'string' ? args[2] : ''
    if (str === null || search === null) return null
    return str.split(search).join(replacement)
  },

  contains: (args) => {
    if (args.length < 2) return false
    const haystack = args[0]
    const needle = args[1]

    if (typeof haystack === 'string' && typeof needle === 'string') {
      return haystack.toLowerCase().includes(needle.toLowerCase())
    }
    if (Array.isArray(haystack)) {
      return haystack.some((item) =>
        typeof item === 'string' && typeof needle === 'string'
          ? item.toLowerCase() === needle.toLowerCase()
          : item === needle
      )
    }
    return false
  },

  startsWith: (args) => {
    if (args.length < 2) return false
    const str = typeof args[0] === 'string' ? args[0] : null
    const prefix = typeof args[1] === 'string' ? args[1] : null
    if (str === null || prefix === null) return false
    return str.toLowerCase().startsWith(prefix.toLowerCase())
  },

  endsWith: (args) => {
    if (args.length < 2) return false
    const str = typeof args[0] === 'string' ? args[0] : null
    const suffix = typeof args[1] === 'string' ? args[1] : null
    if (str === null || suffix === null) return false
    return str.toLowerCase().endsWith(suffix.toLowerCase())
  },

  length: (args) => {
    if (args.length < 1) return null
    const val = args[0]
    if (typeof val === 'string') return val.length
    if (Array.isArray(val)) return val.length
    return null
  },

  // Number functions
  round: (args) => {
    if (args.length < 1) return null
    const num = typeof args[0] === 'number' ? args[0] : null
    if (num === null) return null
    const decimals = typeof args[1] === 'number' ? args[1] : 0
    const factor = Math.pow(10, decimals)
    return Math.round(num * factor) / factor
  },

  floor: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'number' ? Math.floor(args[0]) : null
  },

  ceil: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'number' ? Math.ceil(args[0]) : null
  },

  abs: (args) => {
    if (args.length < 1) return null
    return typeof args[0] === 'number' ? Math.abs(args[0]) : null
  },

  min: (args) => {
    const numbers = args.filter((a): a is number => typeof a === 'number')
    if (numbers.length === 0) return null
    return Math.min(...numbers)
  },

  max: (args) => {
    const numbers = args.filter((a): a is number => typeof a === 'number')
    if (numbers.length === 0) return null
    return Math.max(...numbers)
  },

  sum: (args) => {
    let total = 0
    for (const arg of args) {
      if (typeof arg === 'number') {
        total += arg
      } else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (typeof item === 'number') {
            total += item
          }
        }
      }
    }
    return total
  },

  avg: (args) => {
    const numbers: number[] = []
    for (const arg of args) {
      if (typeof arg === 'number') {
        numbers.push(arg)
      } else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (typeof item === 'number') {
            numbers.push(item)
          }
        }
      }
    }
    if (numbers.length === 0) return null
    return numbers.reduce((a, b) => a + b, 0) / numbers.length
  },

  toFixed: (args) => {
    if (args.length < 1) return null
    const num = typeof args[0] === 'number' ? args[0] : null
    if (num === null) return null
    const decimals = typeof args[1] === 'number' ? args[1] : 2
    return num.toFixed(decimals)
  },

  // Type conversion
  number: (args) => {
    if (args.length < 1) return null
    const val = args[0]
    if (typeof val === 'number') return val
    if (typeof val === 'string') {
      const num = parseFloat(val)
      return isNaN(num) ? null : num
    }
    if (typeof val === 'boolean') return val ? 1 : 0
    return null
  },

  string: (args) => {
    if (args.length < 1) return null
    const val = args[0]
    if (val === null || val === undefined) return null
    if (val instanceof Date) return val.toISOString()
    return String(val)
  },

  boolean: (args) => {
    if (args.length < 1) return null
    const val = args[0]
    if (typeof val === 'boolean') return val
    if (typeof val === 'number') return val !== 0
    if (typeof val === 'string') return val.length > 0 && val.toLowerCase() !== 'false'
    return val !== null && val !== undefined
  },

  // Array functions
  join: (args) => {
    if (args.length < 1) return null
    const arr = Array.isArray(args[0]) ? args[0] : null
    if (!arr) return null
    const separator = typeof args[1] === 'string' ? args[1] : ', '
    return arr.join(separator)
  },

  first: (args) => {
    if (args.length < 1) return null
    const arr = Array.isArray(args[0]) ? args[0] : null
    if (!arr || arr.length === 0) return null
    return arr[0]
  },

  last: (args) => {
    if (args.length < 1) return null
    const arr = Array.isArray(args[0]) ? args[0] : null
    if (!arr || arr.length === 0) return null
    return arr[arr.length - 1]
  },

  // Utility
  empty: (args) => {
    if (args.length < 1) return true
    const val = args[0]
    if (val === null || val === undefined) return true
    if (typeof val === 'string') return val.trim().length === 0
    if (Array.isArray(val)) return val.length === 0
    return false
  },

  default: (args) => {
    if (args.length < 2) return args[0] ?? null
    const val = args[0]
    const defaultVal = args[1]
    if (val === null || val === undefined || val === '') {
      return defaultVal
    }
    return val
  }
}

// ============================================================================
// Variable Resolution
// ============================================================================

/**
 * Resolve a variable name to its value from the context.
 */
function resolveVariable(name: string, context: FormulaContext): unknown {
  const { note } = context

  // Check note properties first
  if (name in note.properties) {
    return note.properties[name]
  }

  // Built-in note fields
  switch (name) {
    case 'title':
      return note.title
    case 'path':
      return note.path
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
    case 'id':
      return note.id
  }

  return undefined
}

/**
 * Resolve a member access expression (e.g., file.name, note.tags).
 */
function resolveMember(object: string, property: string, context: FormulaContext): unknown {
  const { note } = context

  // file.* properties
  if (object === 'file') {
    const path = note.path
    switch (property) {
      case 'name': {
        const parts = path.split('/')
        const filename = parts[parts.length - 1]
        return filename.replace(/\.md$/, '')
      }
      case 'path':
        return path
      case 'folder':
        return note.folder
      case 'created':
        return note.created
      case 'modified':
        return note.modified
      case 'ext':
        return '.md'
    }
  }

  // note.* properties (aliases for top-level)
  if (object === 'note') {
    switch (property) {
      case 'title':
        return note.title
      case 'tags':
        return note.tags
      case 'wordCount':
        return note.wordCount
      case 'created':
        return note.created
      case 'modified':
        return note.modified
      case 'folder':
        return note.folder
      case 'emoji':
        return note.emoji
    }
  }

  return undefined
}

// ============================================================================
// AST Evaluation
// ============================================================================

/**
 * Evaluate an AST node against the context.
 */
export function evaluateAST(node: ASTNode, context: FormulaContext): unknown {
  switch (node.type) {
    case 'literal':
      return node.value

    case 'identifier':
      return resolveVariable(node.name, context)

    case 'member': {
      // Handle chained member access like file.name
      if (node.object.type === 'identifier') {
        return resolveMember(node.object.name, node.property, context)
      }
      // Handle property access on evaluated value
      const obj = evaluateAST(node.object, context)
      if (obj && typeof obj === 'object' && node.property in obj) {
        return (obj as Record<string, unknown>)[node.property]
      }
      return undefined
    }

    case 'unary': {
      const arg = evaluateAST(node.argument, context)
      switch (node.operator) {
        case '!':
          return !arg
        case '-':
          return typeof arg === 'number' ? -arg : null
        default:
          return null
      }
    }

    case 'binary': {
      const left = evaluateAST(node.left, context)
      const right = evaluateAST(node.right, context)
      return evaluateBinaryOp(node.operator, left, right)
    }

    case 'call': {
      const fn = BUILT_IN_FUNCTIONS[node.callee]
      if (!fn) {
        console.warn(`Unknown function: ${node.callee}`)
        return null
      }
      const args = node.arguments.map((arg) => evaluateAST(arg, context))
      return fn(args, context)
    }

    case 'conditional': {
      const test = evaluateAST(node.test, context)
      return test ? evaluateAST(node.consequent, context) : evaluateAST(node.alternate, context)
    }

    default:
      return null
  }
}

/**
 * Evaluate a binary operation.
 */
function evaluateBinaryOp(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    // Logical
    case '||':
      return left || right
    case '&&':
      return left && right

    // Comparison (with type coercion for dates)
    case '==':
      return compareValues(left, right) === 0
    case '!=':
      return compareValues(left, right) !== 0
    case '<':
      return compareValues(left, right) < 0
    case '>':
      return compareValues(left, right) > 0
    case '<=':
      return compareValues(left, right) <= 0
    case '>=':
      return compareValues(left, right) >= 0

    // Arithmetic
    case '+': {
      // String concatenation
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left ?? '') + String(right ?? '')
      }
      // Number addition
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null) return null
      return l + r
    }
    case '-': {
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null) return null
      return l - r
    }
    case '*': {
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null) return null
      return l * r
    }
    case '/': {
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null || r === 0) return null
      return l / r
    }
    case '%': {
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null || r === 0) return null
      return l % r
    }
    case '**': {
      const l = typeof left === 'number' ? left : null
      const r = typeof right === 'number' ? right : null
      if (l === null || r === null) return null
      return Math.pow(l, r)
    }

    default:
      return null
  }
}

/**
 * Compare two values, handling dates and different types.
 */
function compareValues(left: unknown, right: unknown): number {
  // Handle null/undefined
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1
  }
  if (right === null || right === undefined) {
    return 1
  }

  // Try to parse as dates if strings look like dates
  const leftDate = parseDate(left)
  const rightDate = parseDate(right)
  if (leftDate && rightDate) {
    return leftDate.getTime() - rightDate.getTime()
  }

  // Number comparison
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }

  // String comparison
  const leftStr = String(left)
  const rightStr = String(right)
  return leftStr.localeCompare(rightStr)
}

// ============================================================================
// Main Exports
// ============================================================================

/**
 * Evaluate a formula expression against a note.
 *
 * @param expression - The formula expression string
 * @param note - The note to evaluate against
 * @returns The result of evaluation, or null on error
 *
 * @example
 * evaluateFormula('price * quantity', note)
 * // => 150
 *
 * @example
 * evaluateFormula('dateDiff(due_date, today(), "days")', note)
 * // => 14
 */
export function evaluateFormula(expression: string, note: NoteWithProperties): unknown {
  try {
    const ast = parseExpression(expression)
    return evaluateAST(ast, { note })
  } catch (err) {
    if (err instanceof ParseError) {
      console.warn(`Formula parse error: ${err.message}`)
    } else {
      console.warn(`Formula evaluation error:`, err)
    }
    return null
  }
}

/**
 * Evaluate a formula with full context.
 */
export function evaluateFormulaWithContext(expression: string, context: FormulaContext): unknown {
  try {
    const ast = parseExpression(expression)
    return evaluateAST(ast, context)
  } catch (err) {
    if (err instanceof ParseError) {
      console.warn(`Formula parse error: ${err.message}`)
    } else {
      console.warn(`Formula evaluation error:`, err)
    }
    return null
  }
}

/**
 * Get list of available built-in functions.
 */
export function getBuiltInFunctions(): string[] {
  return Object.keys(BUILT_IN_FUNCTIONS).sort()
}

/**
 * Check if a function name is a built-in function.
 */
export function isBuiltInFunction(name: string): boolean {
  return name in BUILT_IN_FUNCTIONS
}

export default evaluateFormula
