/**
 * Quick-add syntax layer for the shared CaptureBar.
 *
 * Two pieces, both opt-in through CaptureBar's `quickAdd` prop: the coloured
 * token overlay painted behind the text field, and the inline ghost completion
 * that finishes the trigger being typed (`@tomo` → `@tomorrow`).
 *
 * Surfaces that only capture prose (the Inbox) never render any of this.
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  findQuickAddSpans,
  getDateOptions,
  getPriorityOptions,
  getProjectOptions,
  predictRepeatCompletion,
  type AutocompleteOption,
  type QuickAddSpanKind
} from '@/lib/quick-add-parser'
import { predictDateCompletion } from '@/lib/date-phrase-completion'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TOKEN HIGHLIGHT OVERLAY
// ============================================================================

type TokenKind = QuickAddSpanKind | 'plain'

interface Token {
  text: string
  kind: TokenKind
  start: number
}

const TOKEN_STYLES: Record<Exclude<TokenKind, 'plain'>, string> = {
  date: 'text-task-token-date bg-task-token-date/10 rounded px-0.5 -mx-0.5',
  priority: 'rounded px-0.5 -mx-0.5',
  project: 'text-task-token-project bg-task-token-project/10 rounded px-0.5 -mx-0.5',
  // The natural-language forms read as one phrase rather than one word, so they
  // get the fuller pill: same metrics, rounder shell, stronger fill.
  datePhrase: 'text-task-token-date bg-task-token-date/15 rounded-full px-0.5 -mx-0.5',
  repeat: 'text-task-repeat bg-task-repeat/15 rounded-full px-0.5 -mx-0.5'
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-task-priority-urgent bg-task-priority-urgent/10',
  u: 'text-task-priority-urgent bg-task-priority-urgent/10',
  high: 'text-task-priority-high bg-task-priority-high/10',
  h: 'text-task-priority-high bg-task-priority-high/10',
  medium: 'text-task-priority-medium bg-task-priority-medium/10',
  med: 'text-task-priority-medium bg-task-priority-medium/10',
  m: 'text-task-priority-medium bg-task-priority-medium/10',
  low: 'text-task-priority-low bg-task-priority-low/10',
  l: 'text-task-priority-low bg-task-priority-low/10',
  none: 'text-muted-foreground bg-muted/50',
  n: 'text-muted-foreground bg-muted/50'
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0

  for (const span of findQuickAddSpans(input)) {
    if (span.start > lastIndex) {
      tokens.push({ text: input.slice(lastIndex, span.start), kind: 'plain', start: lastIndex })
    }
    tokens.push({ text: input.slice(span.start, span.end), kind: span.kind, start: span.start })
    lastIndex = span.end
  }

  if (lastIndex < input.length) {
    tokens.push({ text: input.slice(lastIndex), kind: 'plain', start: lastIndex })
  }

  return tokens
}

export const TokenOverlay = ({
  value,
  ghost = ''
}: {
  value: string
  /** Un-typed remainder of the completion, painted after the caret. */
  ghost?: string
}): React.JSX.Element => {
  const tokens = useMemo(() => tokenize(value), [value])

  return (
    <span>
      {tokens.map((token) => {
        if (token.kind === 'plain') {
          return (
            <span key={token.start} className="text-text-primary">
              {token.text}
            </span>
          )
        }

        if (token.kind === 'priority') {
          const keyword = token.text.slice(2).toLowerCase()
          const colorClass =
            PRIORITY_COLORS[keyword] ?? 'text-task-priority-high bg-task-priority-high/10'
          return (
            <span key={token.start} className={cn(TOKEN_STYLES.priority, colorClass)}>
              {token.text}
            </span>
          )
        }

        return (
          <span key={token.start} className={TOKEN_STYLES[token.kind]}>
            {token.text}
          </span>
        )
      })}
      {ghost && (
        <span data-testid="capture-bar-ghost" className="text-text-tertiary">
          {ghost}
        </span>
      )}
    </span>
  )
}

// ============================================================================
// TRAILING-TOKEN HELPERS
// ============================================================================

/**
 * The run of non-whitespace the caret is sitting at the end of. Newline-aware,
 * because the shared field is a textarea: `"a\nb #wo"` yields `"#wo"`.
 */
export function lastToken(value: string): string {
  return /\S*$/.exec(value)?.[0] ?? ''
}

/** Swap the trigger the caret is in for a completion, caret past a space. */
export function replaceTrigger(value: string, start: number, replacement: string): string {
  return `${value.slice(0, start)}${replacement} `
}

// ============================================================================
// INLINE GHOST COMPLETION
// ============================================================================

type TriggerKind = 'date' | 'datePhrase' | 'priority' | 'project' | 'repeat'

interface Trigger {
  kind: TriggerKind
  /** What has been typed after the trigger character (repeats keep "every"). */
  query: string
  /** Index in the value where the trigger starts. */
  start: number
}

/**
 * The quick-add trigger the caret is sitting in, if any.
 *
 * The sigil forms (`!`, `!!`, `#`) are one token; the natural-language forms
 * (`@next wednesday`, `every 2 weeks`) run over several words, so they are read
 * from their trigger word up to the end of the value instead.
 */
export function detectTrigger(value: string): Trigger | null {
  const token = lastToken(value)
  const tokenStart = value.length - token.length

  // `!!` before `!`: priority is the more specific trigger.
  if (token.startsWith('!!')) return { kind: 'priority', query: token.slice(2), start: tokenStart }
  if (token.startsWith('!')) return { kind: 'date', query: token.slice(1), start: tokenStart }
  if (token.startsWith('#')) return { kind: 'project', query: token.slice(1), start: tokenStart }

  // Multi-word triggers live on the caret's line; the nearest one wins.
  const lineStart = value.lastIndexOf('\n') + 1
  const line = value.slice(lineStart)

  const at = line.lastIndexOf('@')
  const atStart = at >= 0 && (at === 0 || /\s/.test(line[at - 1])) ? lineStart + at : -1

  const everyMatches = [...line.matchAll(/\bevery\b/gi)]
  const every = everyMatches.length > 0 ? everyMatches[everyMatches.length - 1].index : -1
  const everyStart = every >= 0 ? lineStart + every : -1

  if (atStart < 0 && everyStart < 0) return null
  if (atStart > everyStart) {
    return { kind: 'datePhrase', query: value.slice(atStart + 1), start: atStart }
  }
  return { kind: 'repeat', query: value.slice(everyStart), start: everyStart }
}

/** First option whose value continues what has been typed. */
function firstCompletion(options: AutocompleteOption[], typed: string): string | null {
  const lower = typed.toLowerCase()
  return options.find((option) => option.value.toLowerCase().startsWith(lower))?.value ?? null
}

function predictFor(trigger: Trigger, typed: string, projects: Project[]): string | null {
  switch (trigger.kind) {
    case 'datePhrase': {
      // The note editor's `@`-mention predictor, so both surfaces complete a
      // half-typed date the same way.
      const completion = predictDateCompletion(trigger.query)
      return completion === null ? null : `@${completion}`
    }
    case 'repeat':
      return predictRepeatCompletion(trigger.query)
    case 'date':
      return firstCompletion(getDateOptions(trigger.query), typed)
    case 'priority':
      return firstCompletion(getPriorityOptions(trigger.query), typed)
    case 'project':
      return firstCompletion(getProjectOptions(trigger.query, projects), typed)
  }
}

export interface GhostCompletion {
  /** Index in the value where the completed text starts. */
  start: number
  /** The whole trigger in canonical casing, e.g. `@Tomorrow`. */
  text: string
  /** The part not yet typed — what gets painted after the caret. */
  remainder: string
}

/**
 * What the ghost should offer for the text at the caret, or null when there is
 * nothing to finish. The prediction is always a case-insensitive superstring of
 * what the user typed, so accepting it never loses characters.
 */
export function predictCompletion(value: string, projects: Project[]): GhostCompletion | null {
  const trigger = detectTrigger(value)
  if (!trigger) return null

  const typed = value.slice(trigger.start)
  const text = predictFor(trigger, typed, projects)
  if (!text || !text.toLowerCase().startsWith(typed.toLowerCase())) return null

  const remainder = text.slice(typed.length)
  return remainder ? { start: trigger.start, text, remainder } : null
}
