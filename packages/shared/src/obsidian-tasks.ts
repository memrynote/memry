/**
 * Reads a task line written by the Obsidian Tasks plugin, in either of the two
 * formats that plugin emits: the emoji format (`- [ ] Buy milk 📅 2026-01-01 ⏫`)
 * and the Dataview inline-field format (`- [ ] Buy milk  [due:: 2026-01-01]`).
 * Kept dependency-free and pure so the vault importer in the main process and
 * any preview in the renderer read a line exactly the same way.
 *
 * Both symbol tables are stripped in one loop instead of behind a format flag.
 * A vault is free to mix the two on a single line, the two syntaxes share no
 * characters, and guessing a per-note format would be wrong for precisely the
 * notes that are half migrated. Nothing here exposes which format a line used.
 *
 * `obsidianTaskImportBlocker` names the three constructs Memry must not rewrite.
 * Memry's own `{task:<id>}` suffix has to be the last thing on the line, but the
 * plugin's block-link regex and every one of its field regexes are end-anchored,
 * so appending the suffix un-anchors all of them and the plugin stops seeing its
 * own fields. `🆔` and `⛔` are worse than that: they form a dependency graph
 * spanning files Memry has not read, so rewriting one line can silently break a
 * link in another note. For those three, Memry leaves the line alone.
 */

export type ObsidianPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest'

export type ObsidianStatusType =
  'TODO' | 'DONE' | 'IN_PROGRESS' | 'CANCELLED' | 'ON_HOLD' | 'NON_TASK' | 'EMPTY'

export interface ObsidianRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  fromCompletion: boolean
}

export interface ObsidianTaskFields {
  description: string
  tags: string[]
  priority: ObsidianPriority | null
  dueDate: string | null
  scheduledDate: string | null
  startDate: string | null
  createdDate: string | null
  doneDate: string | null
  cancelledDate: string | null
  recurrenceText: string | null
  recurrence: ObsidianRecurrence | null
  onCompletion: string | null
  id: string | null
  dependsOn: string[]
  blockLink: string | null
}

export interface ObsidianTaskLine extends ObsidianTaskFields {
  indentation: string
  listMarker: string
  statusChar: string
  statusType: ObsidianStatusType
}

export type ObsidianImportBlocker = 'block-link' | 'task-id' | 'depends-on'

/** The slots the strip loop fills. Description, tags and block link are derived around it. */
type MutableFields = Omit<ObsidianTaskFields, 'description' | 'tags' | 'blockLink'>

type DateField = keyof Pick<
  MutableFields,
  'dueDate' | 'scheduledDate' | 'startDate' | 'createdDate' | 'doneDate' | 'cancelledDate'
>

interface FieldRule {
  regex: RegExp
  apply: (match: RegExpMatchArray, out: MutableFields) => void
}

const TASK_ID_SOURCE = '[a-zA-Z0-9_-]+'
const TASK_ID_SEQUENCE_SOURCE = `${TASK_ID_SOURCE}( *, *${TASK_ID_SOURCE} *)*`
const DATE_SOURCE = '(\\d{4}-\\d{2}-\\d{2})'

const HASH_TAG_SOURCE = '(^|\\s)#[^ !@#$%^&*(),.?":{}|<>]+'
const HASH_TAGS = new RegExp(HASH_TAG_SOURCE, 'g')
const HASH_TAG_FROM_END = new RegExp(HASH_TAG_SOURCE + '$')
const HASH_TAG_ANYWHERE = new RegExp(HASH_TAG_SOURCE)

const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u
const TASK_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u

const DATAVIEW_MARKER = '::'

const EMOJI_SYMBOLS = [
  '🔺',
  '⏫',
  '🔼',
  '🔽',
  '⏬',
  '🛫',
  '➕',
  '⏳',
  '⌛',
  '📅',
  '📆',
  '🗓',
  '✅',
  '❌',
  '🔁',
  '🏁',
  '⛔',
  '🆔'
]

const PRIORITIES = new Map<string, ObsidianPriority>([
  ['🔺', 'highest'],
  ['⏫', 'high'],
  ['🔼', 'medium'],
  ['🔽', 'low'],
  ['⏬', 'lowest'],
  ['highest', 'highest'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  ['lowest', 'lowest']
])

const WEEKDAYS = new Map<string, number>([
  ['sun', 0],
  ['sunday', 0],
  ['mon', 1],
  ['monday', 1],
  ['tue', 2],
  ['tuesday', 2],
  ['wed', 3],
  ['wednesday', 3],
  ['thu', 4],
  ['thursday', 4],
  ['fri', 5],
  ['friday', 5],
  ['sat', 6],
  ['saturday', 6]
])

const RECURRENCE_UNITS = new Map<string, ObsidianRecurrence['frequency']>([
  ['day', 'daily'],
  ['week', 'weekly'],
  ['month', 'monthly'],
  ['year', 'yearly']
])

const RECURRENCE_INTERVAL = /^(?:(\d+) +)?(day|week|month|year)s?$/

// Every emoji symbol tolerates a trailing Variant Selector 16, as the plugin's
// own field regexes do: a keyboard or a note editor can insert one, and it is
// invisible, so a line that looks identical would otherwise parse differently.
// Spelled as an escape so no editor or formatter can strip it unnoticed.
const VARIANT_SELECTOR_16 = '\uFE0F'

function fieldRegex(symbols: string, valueSource: string): RegExp {
  const value = valueSource === '' ? '' : ' *' + valueSource
  return new RegExp(symbols + VARIANT_SELECTOR_16 + '?' + value + '$')
}

// The bracket/paren lookahead is the plugin's own trick for `[key:: value]` and
// `(key:: value)` without accepting a mismatched pair, and without adding a
// capture group that would renumber the value group inside `inner`.
function inlineFieldRegex(inner: string): RegExp {
  return new RegExp('(?:(?=[^\\]]+\\])\\[|(?=[^)]+\\))\\() *' + inner + ' *[)\\]](?: *,)?$')
}

function priorityRule(regex: RegExp): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      out.priority = PRIORITIES.get(match[1]) ?? null
    }
  }
}

function dateRule(regex: RegExp, field: DateField): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      out[field] = match[1]
    }
  }
}

function recurrenceRule(regex: RegExp): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      const text = match[1].trim()
      out.recurrenceText = text
      out.recurrence = parseRecurrence(text)
    }
  }
}

function onCompletionRule(regex: RegExp): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      out.onCompletion = match[1]
    }
  }
}

function idRule(regex: RegExp): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      out.id = match[1].trim()
    }
  }
}

function dependsOnRule(regex: RegExp): FieldRule {
  return {
    regex,
    apply: (match, out) => {
      out.dependsOn = match[1]
        .replace(/ /g, '')
        .split(',')
        .filter((item) => item !== '')
    }
  }
}

const EMOJI_RULES: FieldRule[] = [
  priorityRule(fieldRegex('(🔺|⏫|🔼|🔽|⏬)', '')),
  dateRule(fieldRegex('✅', DATE_SOURCE), 'doneDate'),
  dateRule(fieldRegex('❌', DATE_SOURCE), 'cancelledDate'),
  dateRule(fieldRegex('(?:📅|📆|🗓)', DATE_SOURCE), 'dueDate'),
  dateRule(fieldRegex('(?:⏳|⌛)', DATE_SOURCE), 'scheduledDate'),
  dateRule(fieldRegex('🛫', DATE_SOURCE), 'startDate'),
  dateRule(fieldRegex('➕', DATE_SOURCE), 'createdDate'),
  recurrenceRule(fieldRegex('🔁', '([a-zA-Z0-9, !]+)')),
  onCompletionRule(fieldRegex('🏁', '([a-zA-Z]+)')),
  idRule(fieldRegex('🆔', '(' + TASK_ID_SOURCE + ')')),
  dependsOnRule(fieldRegex('⛔', '(' + TASK_ID_SEQUENCE_SOURCE + ')'))
]

const DATAVIEW_RULES: FieldRule[] = [
  priorityRule(inlineFieldRegex('priority:: *(highest|high|medium|low|lowest)')),
  dateRule(inlineFieldRegex('completion:: *' + DATE_SOURCE), 'doneDate'),
  dateRule(inlineFieldRegex('cancelled:: *' + DATE_SOURCE), 'cancelledDate'),
  dateRule(inlineFieldRegex('due:: *' + DATE_SOURCE), 'dueDate'),
  dateRule(inlineFieldRegex('scheduled:: *' + DATE_SOURCE), 'scheduledDate'),
  dateRule(inlineFieldRegex('start:: *' + DATE_SOURCE), 'startDate'),
  dateRule(inlineFieldRegex('created:: *' + DATE_SOURCE), 'createdDate'),
  recurrenceRule(inlineFieldRegex('repeat:: *([a-zA-Z0-9, !]+)')),
  onCompletionRule(inlineFieldRegex('onCompletion:: *([a-zA-Z]+)')),
  idRule(inlineFieldRegex('id:: *(' + TASK_ID_SOURCE + ')')),
  dependsOnRule(inlineFieldRegex('dependsOn:: *(' + TASK_ID_SEQUENCE_SOURCE + ')'))
]

function parseWeekdays(text: string): number[] | null {
  const days: number[] = []
  for (const token of text.split(/,| and /)) {
    const name = token.trim()
    if (name === '') continue
    const day = WEEKDAYS.get(name)
    if (day === undefined) return null
    if (!days.includes(day)) days.push(day)
  }
  if (days.length === 0) return null
  return days.sort((a, b) => a - b)
}

// A deliberate subset of the plugin's rrule support: the rules Memry can honour
// exactly. Anything richer keeps its raw text and imports without a schedule,
// which a user can fix, where a half-understood rule would fire on wrong days.
function parseRecurrence(text: string): ObsidianRecurrence | null {
  const whenDone = ' when done'
  let rule = text.trim().toLowerCase()
  let fromCompletion = false

  if (rule.endsWith(whenDone)) {
    fromCompletion = true
    rule = rule.slice(0, -whenDone.length).trim()
  }

  if (!rule.startsWith('every')) return null
  const rest = rule.slice('every'.length).trim()

  if (rest === 'weekday') {
    return { frequency: 'weekly', interval: 1, daysOfWeek: [1, 2, 3, 4, 5], fromCompletion }
  }

  const interval = rest.match(RECURRENCE_INTERVAL)
  if (interval !== null) {
    const frequency = RECURRENCE_UNITS.get(interval[2])
    if (frequency === undefined) return null
    return {
      frequency,
      interval: interval[1] === undefined ? 1 : Number(interval[1]),
      fromCompletion
    }
  }

  const daysOfWeek = parseWeekdays(rest)
  if (daysOfWeek === null) return null
  return { frequency: 'weekly', interval: 1, daysOfWeek, fromCompletion }
}

function extractTags(description: string): string[] {
  const matches = description.match(HASH_TAGS)
  if (matches === null) return []

  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of matches) {
    const tag = raw.trim()
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function emptyFields(): MutableFields {
  return {
    priority: null,
    dueDate: null,
    scheduledDate: null,
    startDate: null,
    createdDate: null,
    doneDate: null,
    cancelledDate: null,
    recurrenceText: null,
    recurrence: null,
    onCompletion: null,
    id: null,
    dependsOn: []
  }
}

// Every rule is end-anchored, so fields come off the tail one at a time and the
// pass repeats until nothing more matches. The order inside a pass is the
// plugin's, which settles a line written in the order the plugin writes it in a
// single pass.
//
// The dataview rules carry variable-length lookaheads (`(?=[^\]]+\])`) that scan
// quadratically on a long line, so a table is skipped outright unless the
// original input holds something it could match. Stripping only ever removes
// text, so a table that cannot match the input cannot match any later state.
function stripFields(input: string, out: MutableFields): string {
  const tables: FieldRule[][] = []
  if (EMOJI_SYMBOLS.some((symbol) => input.includes(symbol))) tables.push(EMOJI_RULES)
  if (input.includes(DATAVIEW_MARKER)) tables.push(DATAVIEW_RULES)

  let text = input
  let trailingTags = ''
  let matched = false
  let runs = 0

  do {
    matched = false

    for (const rules of tables) {
      for (const rule of rules) {
        const match = text.match(rule.regex)
        if (match === null) continue
        rule.apply(match, out)
        text = text.replace(rule.regex, '').trim()
        matched = true
      }
    }

    const tag = text.match(HASH_TAG_FROM_END)
    if (tag !== null) {
      const name = tag[0].trim()
      trailingTags = trailingTags.length > 0 ? name + ' ' + trailingTags : name
      text = text.replace(HASH_TAG_FROM_END, '').trim()
      matched = true
    }

    runs++
  } while (matched && runs <= 20)

  // Tags are peeled off the end only so the fields behind them become reachable.
  // They were part of what the user wrote, so they go back on the description:
  // `Do it #tag1 📅 2026-01-01 #tag2` describes `Do it #tag1 #tag2`.
  if (trailingTags.length > 0) {
    text += (text.length > 0 ? ' ' : '') + trailingTags
  }

  return text
}

export function hasObsidianTaskFields(text: string): boolean {
  if (text.includes(DATAVIEW_MARKER)) return true
  if (EMOJI_SYMBOLS.some((symbol) => text.includes(symbol))) return true
  if (BLOCK_LINK.test(text)) return true
  return HASH_TAG_ANYWHERE.test(text)
}

export function parseObsidianTaskFields(text: string): ObsidianTaskFields {
  let body = text.trim()

  // Peeled before the strip loop, as the plugin does: every field regex is
  // end-anchored, so a trailing block link would hide the field in front of it.
  const link = body.match(BLOCK_LINK)
  let blockLink: string | null = null
  if (link !== null) {
    blockLink = link[0].trim()
    body = body.replace(BLOCK_LINK, '').trim()
  }

  const out = emptyFields()
  const description = stripFields(body, out)

  return { description, tags: extractTags(description), ...out, blockLink }
}

function statusTypeFor(statusChar: string): ObsidianStatusType {
  switch (statusChar) {
    case 'x':
    case 'X':
      return 'DONE'
    case '/':
      return 'IN_PROGRESS'
    case '-':
      return 'CANCELLED'
    case '':
      return 'EMPTY'
    default:
      return 'TODO'
  }
}

export function parseObsidianTaskLine(line: string): ObsidianTaskLine | null {
  const match = line.match(TASK_LINE)
  if (match === null) return null

  const statusChar = match[3]
  return {
    ...parseObsidianTaskFields(match[4]),
    indentation: match[1],
    listMarker: match[2],
    statusChar,
    statusType: statusTypeFor(statusChar)
  }
}

export function obsidianTaskImportBlocker(text: string): ObsidianImportBlocker | null {
  if (BLOCK_LINK.test(text)) return 'block-link'

  const fields = parseObsidianTaskFields(text)
  if (fields.id !== null) return 'task-id'
  if (fields.dependsOn.length > 0) return 'depends-on'
  return null
}
