// ============================================================================
// NATURAL DATE PARSER
// ============================================================================
// The grammar lives in `@memry/domain-tasks/parsing` so the iOS core can be held
// to it by conformance vectors (spec 004 D1, D5). This module only supplies the
// renderer's clock.

import {
  lastMonday as lastMondayFrom,
  nextMonday as nextMondayFrom,
  nextSaturday as nextSaturdayFrom,
  parseNaturalDate as parseNaturalDateAt
} from '@memry/domain-tasks/parsing'
import type { NaturalDateParseResult } from '@memry/domain-tasks/parsing'

export type {
  NaturalDateParseResult,
  ParseError,
  ParseResult,
  ParsedDateResult
} from '@memry/domain-tasks/parsing'

export { addMonths, addWeeks } from '@memry/domain-tasks/parsing'

/** Get last week's Monday (for "last week"). */
export const lastMonday = (from: Date = new Date()): Date => lastMondayFrom(from)

/** Get the next Saturday (for "this weekend"). */
export const nextSaturday = (from: Date = new Date()): Date => nextSaturdayFrom(from)

/** Get the next Monday (for "next week"). */
export const nextMonday = (from: Date = new Date()): Date => nextMondayFrom(from)

/**
 * Parse natural language date input
 *
 * Supports:
 * - Relative: "today", "tomorrow", "yesterday", "next week", "in 3 days"
 * - Day names: "monday", "next friday", "this saturday"
 * - Month day: "dec 25", "december 25", "25th"
 * - Date formats: "12/25", "12-25"
 * - With time: "tomorrow at 3pm", "next friday 2:30pm"
 */
export const parseNaturalDate = (input: string, now: Date = new Date()): NaturalDateParseResult =>
  parseNaturalDateAt(input, now)

export default parseNaturalDate
