import type { ContentType, SearchResultGroup } from '@memry/contracts/search-api'
import type { DatePresetId } from './search-date-presets'
import { resultValue } from './search-result-item'

type PrimaryActionKey =
  | 'searchPalette.actions.open'
  | 'searchPalette.actions.openNote'
  | 'searchPalette.actions.openFile'
  | 'searchPalette.actions.openJournal'
  | 'searchPalette.actions.openTask'
  | 'searchPalette.actions.openInInbox'
  | 'searchPalette.actions.addFilter'
  | 'searchPalette.actions.removeFilter'
  | 'searchPalette.actions.chooseTag'
  | 'searchPalette.actions.addTag'
  | 'searchPalette.actions.showAll'
  | 'searchPalette.actions.searchEverywhere'
  | 'searchPalette.actions.clearFilters'

interface PrimaryActionContext {
  results: SearchResultGroup[]
  activeTypes: ContentType[]
  activeDate: DatePresetId | null
}

/** The verb the action bar shows for Enter on the selected row. */
export function primaryActionKey(
  value: string,
  { results, activeTypes, activeDate }: PrimaryActionContext
): PrimaryActionKey | null {
  const [kind, a, b] = value.split(':')
  const toggle = (active: boolean): PrimaryActionKey =>
    active ? 'searchPalette.actions.removeFilter' : 'searchPalette.actions.addFilter'
  switch (kind) {
    case 'result': {
      const item = results.flatMap((g) => g.results).find((r) => resultValue(r) === value)
      if (!item) return null
      switch (item.metadata.type) {
        case 'note':
          return item.metadata.fileType && item.metadata.fileType !== 'markdown'
            ? 'searchPalette.actions.openFile'
            : 'searchPalette.actions.openNote'
        case 'journal':
          return 'searchPalette.actions.openJournal'
        case 'task':
          return 'searchPalette.actions.openTask'
        case 'inbox':
          return 'searchPalette.actions.openInInbox'
      }
      return null
    }
    case 'reason':
      return 'searchPalette.actions.open'
    case 'scope':
      return a === 'tag'
        ? 'searchPalette.actions.chooseTag'
        : toggle(activeTypes.includes(a as ContentType))
    case 'filter':
      if (a === 'tag') return 'searchPalette.actions.chooseTag'
      return toggle(a === 'type' ? activeTypes.includes(b as ContentType) : activeDate === b)
    case 'tag':
      return 'searchPalette.actions.addTag'
    case 'more':
      return 'searchPalette.actions.showAll'
    case 'empty':
      return a === 'everywhere'
        ? 'searchPalette.actions.searchEverywhere'
        : 'searchPalette.actions.clearFilters'
    default:
      return null
  }
}
