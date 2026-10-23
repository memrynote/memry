import type { SearchOptions, SearchResult } from '../app-core/memry-app.ts'
import { getFlag, getFlagList, hasFlag, parseNumber, type ParsedCli } from '../run.ts'

const searchKinds: readonly SearchResult['kind'][] = [
  'note',
  'journal',
  'task',
  'inbox',
  'reminder',
  'template',
  'calendar'
]

function listFlag(parsed: ParsedCli, key: string): string[] {
  return getFlagList(parsed.flags, key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}

function valueFlag(parsed: ParsedCli, key: string): string | undefined {
  if (!hasFlag(parsed.flags, key)) return undefined
  const value = getFlag(parsed.flags, key)
  if (!value || value === 'true') throw new Error(`--${key} needs a value`)
  return value
}

function nonNegativeInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return undefined
  const parsedValue = parseNumber(value, 0)
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`--${key} must be a non-negative integer`)
  }
  return parsedValue
}

/** `search` filter flags. Every flag is optional; none set means the unfiltered search. */
export function parseSearchOptions(parsed: ParsedCli): SearchOptions {
  const types = listFlag(parsed, 'type').map((type) => {
    if (!(searchKinds as readonly string[]).includes(type)) {
      throw new Error(`Invalid --type: ${type} (use ${searchKinds.join('|')})`)
    }
    return type as SearchResult['kind']
  })
  const tags = listFlag(parsed, 'tag').map((tag) => tag.replace(/^#/, ''))
  const limit = nonNegativeInteger(valueFlag(parsed, 'limit'), 'limit')
  if (limit === 0) throw new Error('--limit must be at least 1')

  const from = valueFlag(parsed, 'from')
  const to = valueFlag(parsed, 'to')
  const projectId = valueFlag(parsed, 'project')
  const folderPath = valueFlag(parsed, 'folder')
  const offset = nonNegativeInteger(valueFlag(parsed, 'offset'), 'offset')

  return {
    ...(types.length > 0 ? { types } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(folderPath === undefined ? {} : { folderPath }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset })
  }
}
