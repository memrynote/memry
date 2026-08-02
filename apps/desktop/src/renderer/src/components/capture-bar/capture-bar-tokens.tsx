/**
 * Quick-add syntax layer for the shared CaptureBar.
 *
 * Two pieces, both opt-in through CaptureBar's `quickAdd` prop: the coloured
 * token overlay painted behind the text field, and the option lists that feed
 * the autocomplete dropdown for `!date`, `!!priority` and `#project`.
 *
 * Surfaces that only capture prose (the Inbox) never render any of this.
 */

import { useMemo } from 'react'
import { Calendar, Flag, Folder } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  getDateOptions,
  getPriorityOptions,
  getProjectOptions,
  resolveDateDay
} from '@/lib/quick-add-parser'
import type { Project } from '@/data/tasks-data'
import type { AutocompleteOption, AutocompleteType } from '@/components/tasks/quick-add'

// ============================================================================
// TOKEN HIGHLIGHT OVERLAY
// ============================================================================

type TokenKind = 'date' | 'priority' | 'project' | 'plain'

interface Token {
  text: string
  kind: TokenKind
  start: number
}

const TOKEN_STYLES: Record<Exclude<TokenKind, 'plain'>, string> = {
  date: 'text-task-token-date bg-task-token-date/10 rounded px-0.5 -mx-0.5',
  priority: 'rounded px-0.5 -mx-0.5',
  project: 'text-task-token-project bg-task-token-project/10 rounded px-0.5 -mx-0.5'
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
  const regex = /(!![a-zA-Z]+|(?<![!])![a-zA-Z0-9]+|#[\w-]+)/g
  const tokens: Token[] = []
  let lastIndex = 0

  for (const match of input.matchAll(regex)) {
    const start = match.index
    if (start > lastIndex) {
      tokens.push({ text: input.slice(lastIndex, start), kind: 'plain', start: lastIndex })
    }

    const raw = match[0]
    if (raw.startsWith('!!')) {
      tokens.push({ text: raw, kind: 'priority', start })
    } else if (raw.startsWith('!')) {
      tokens.push({ text: raw, kind: 'date', start })
    } else {
      tokens.push({ text: raw, kind: 'project', start })
    }
    lastIndex = start + raw.length
  }

  if (lastIndex < input.length) {
    tokens.push({ text: input.slice(lastIndex), kind: 'plain', start: lastIndex })
  }

  return tokens
}

export const TokenOverlay = ({ value }: { value: string }): React.JSX.Element => {
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

/** Swap the trailing token for a completion and leave the caret past a space. */
export function replaceLastToken(value: string, replacement: string): string {
  // Function replacer: project names may contain `$`, which would otherwise be
  // read as a replacement pattern.
  return `${value.replace(/\S*$/, () => replacement)} `
}

// ============================================================================
// AUTOCOMPLETE
// ============================================================================

/** Which dropdown, if any, the trailing token asks for. */
export function detectAutocomplete(value: string): { type: AutocompleteType; query: string } {
  const token = lastToken(value)

  // `!!` before `!`: priority is the more specific trigger.
  if (token.startsWith('!!')) return { type: 'priority', query: token.slice(2) }
  if (token.startsWith('!')) return { type: 'date', query: token.slice(1) }
  if (token.startsWith('#')) return { type: 'project', query: token.slice(1) }
  return { type: null, query: '' }
}

const PRIORITY_ICON_COLORS: Record<string, string> = {
  '!!urgent': 'text-task-priority-urgent',
  '!!high': 'text-task-priority-high',
  '!!medium': 'text-task-priority-medium',
  '!!low': 'text-task-priority-low'
}

export function buildAutocompleteOptions(
  type: AutocompleteType,
  query: string,
  projects: Project[]
): AutocompleteOption[] {
  switch (type) {
    case 'date':
      return getDateOptions(query).map((option) => {
        const day = resolveDateDay(option.value.slice(1))
        return {
          value: option.value,
          label: option.label,
          icon: (
            <span className="relative flex h-4 w-4 items-center justify-center text-task-token-date">
              <Calendar className="size-4" />
              {day !== null && (
                <span className="absolute mt-[3px] text-[6px] font-bold leading-none">{day}</span>
              )}
            </span>
          )
        }
      })
    case 'priority':
      return getPriorityOptions(query).map((option) => ({
        value: option.value,
        label: option.label,
        icon: (
          <Flag
            className={cn('size-4', PRIORITY_ICON_COLORS[option.value] ?? 'text-muted-foreground')}
          />
        )
      }))
    case 'project':
      return getProjectOptions(query, projects).map((option) => ({
        value: option.value,
        label: option.label,
        icon: <Folder className="size-4 text-task-token-project" />
      }))
    default:
      return []
  }
}
