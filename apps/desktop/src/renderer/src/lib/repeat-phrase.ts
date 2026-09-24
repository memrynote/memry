/**
 * Natural-language recurrence for quick-add: turns "every monday", "every 2
 * weeks" or "every weekday" into the same {@link RepeatConfig} the repeat
 * picker produces.
 *
 * The grammar lives in `@memry/domain-tasks/parsing` (spec 004 D1, D5); this
 * module supplies the renderer's clock.
 */

import {
  findRepeatPhrase as findRepeatPhraseAt,
  firstOccurrenceFor as firstOccurrenceFrom,
  parseRepeatPhrase as parseRepeatPhraseAt
} from '@memry/domain-tasks/parsing'
import type { RepeatConfig, RepeatPhraseMatch } from '@memry/domain-tasks/parsing'

export type { RepeatPhraseMatch } from '@memry/domain-tasks/parsing'

/**
 * Parse a full "every …" phrase. `anchor` supplies the day-of-month a bare
 * "every month" repeats on — pass the task's due date when it has one.
 */
export const parseRepeatPhrase = (
  phrase: string,
  anchor: Date = new Date(),
  now: Date = new Date()
): RepeatConfig | null => parseRepeatPhraseAt(phrase, anchor, now)

/** Find the first "every …" run in the input that reads as a recurrence. */
export const findRepeatPhrase = (
  input: string,
  anchor: Date = new Date(),
  now: Date = new Date()
): RepeatPhraseMatch | null => findRepeatPhraseAt(input, anchor, now)

/** The date a freshly captured repeating task is due on when it has none. */
export const firstOccurrenceFor = (config: RepeatConfig, from: Date = new Date()): Date =>
  firstOccurrenceFrom(config, from)
