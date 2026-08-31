/**
 * Turns a line written by the Obsidian Tasks plugin into the values Memry's
 * task create call takes. The checkbox converter is the only place a vault's
 * markdown becomes a `tasks` row, so it is also the import path for a vault
 * adopted from Obsidian.
 *
 * Importing rewrites the user's line: the plugin's fields come off it and
 * Memry's `{task:<id>}` suffix goes on. So every task this builds keeps the
 * whole original line in `description`, not just the ones carrying a field
 * Memry has no column for. Mapping a due date into `dueDate` still loses the
 * user's symbol choice, field order and format, and a record only of the
 * fields we happened to find useful is not a record. One line of noise per
 * imported task buys a rewrite the user can undo by hand.
 */

import {
  hasObsidianTaskFields,
  parseObsidianTaskFields,
  type ObsidianPriority
} from '@memry/shared/obsidian-tasks'
import type { RepeatConfig as RepeatConfigInput } from '@memry/rpc/tasks'

export interface ObsidianTaskImport {
  /** The description with every recognised plugin field stripped. Tags stay inline. */
  title: string
  priority: 0 | 1 | 2 | 3 | 4 | null
  dueDate: string | null
  startDate: string | null
  tags: string[]
  repeatConfig: RepeatConfigInput | null
  repeatFrom: 'due' | 'completion' | null
  /** The original line, verbatim, so the rewrite stays reversible by hand. */
  description: string
  /** From the plugin's done date. */
  completedAt: string | null
}

// `lowest` collapses onto `low` because Memry's scale has four steps to the
// plugin's five. The line is preserved so the distinction is not lost.
const PRIORITIES: Record<ObsidianPriority, 1 | 2 | 3 | 4> = {
  highest: 4,
  high: 3,
  medium: 2,
  low: 1,
  lowest: 1
}

/** Null when the text carries nothing this module would change. */
export function buildObsidianTaskImport(text: string, now: Date): ObsidianTaskImport | null {
  if (!hasObsidianTaskFields(text)) return null

  const fields = parseObsidianTaskFields(text)

  // An id, a dependency or a block link are import blockers, not import values,
  // and a bare `#tag` is already Memry's own grammar. A line carrying only
  // those has nothing here to add, and returning null keeps it on the path it
  // takes today.
  const carriesValue =
    fields.priority !== null ||
    fields.dueDate !== null ||
    fields.scheduledDate !== null ||
    fields.startDate !== null ||
    fields.createdDate !== null ||
    fields.doneDate !== null ||
    fields.cancelledDate !== null ||
    fields.recurrenceText !== null ||
    fields.onCompletion !== null
  if (!carriesValue) return null

  const recurrence = fields.recurrence

  return {
    title: fields.description,
    priority: fields.priority === null ? null : PRIORITIES[fields.priority],
    dueDate: fields.dueDate,
    startDate: fields.startDate ?? fields.scheduledDate,
    tags: fields.tags.map((tag) => tag.slice(1)),
    repeatConfig:
      recurrence === null
        ? null
        : {
            frequency: recurrence.frequency,
            interval: recurrence.interval,
            ...(recurrence.daysOfWeek ? { daysOfWeek: recurrence.daysOfWeek } : {}),
            endType: 'never',
            completedCount: 0,
            createdAt: now.toISOString()
          },
    repeatFrom: recurrence === null ? null : recurrence.fromCompletion ? 'completion' : 'due',
    description: text,
    completedAt: fields.doneDate === null ? null : `${fields.doneDate}T00:00:00.000Z`
  }
}
