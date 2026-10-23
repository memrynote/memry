import { Command } from 'cmdk'
import { Calendar, Check, Hash } from '@/lib/icons'
import type { ContentType } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { SearchGroupHeading, SearchKbd, SearchRow } from './search-row'
import { DATE_PRESET_IDS, datePresetSpan, type DatePresetId } from './search-date-presets'
import { CONTENT_TYPES, MOD_KEY, TYPE_ICONS, TYPE_LABEL_KEYS, TYPE_SHORTCUTS } from './search-types'

export const DATE_LABEL_KEYS = {
  today: 'searchPalette.dates.today',
  'this-week': 'searchPalette.dates.thisWeek',
  'this-month': 'searchPalette.dates.thisMonth'
} as const satisfies Record<DatePresetId, string>

export const filterTypeValue = (type: ContentType): string => `filter:type:${type}`
export const filterDateValue = (id: DatePresetId): string => `filter:date:${id}`
export const FILTER_TAG_VALUE = 'filter:tag'

export interface FilterMenuEntries {
  types: ContentType[]
  dates: DatePresetId[]
  tag: boolean
}

/** The menu rows that match what was typed after "/". */
export function filterMenuEntries(
  menuQuery: string,
  label: (key: string) => string
): FilterMenuEntries {
  const q = menuQuery.trim().toLowerCase()
  const matches = (text: string): boolean => !q || text.toLowerCase().includes(q)
  return {
    types: CONTENT_TYPES.filter((type) => matches(label(TYPE_LABEL_KEYS[type]))),
    dates: DATE_PRESET_IDS.filter((id) => matches(label(DATE_LABEL_KEYS[id]))),
    tag: matches(label('searchPalette.tag'))
  }
}

export function filterMenuValues(entries: FilterMenuEntries): string[] {
  return [
    ...entries.types.map(filterTypeValue),
    ...entries.dates.map(filterDateValue),
    ...(entries.tag ? [FILTER_TAG_VALUE] : [])
  ]
}

interface SearchFilterMenuProps {
  entries: FilterMenuEntries
  activeTypes: ContentType[]
  activeDate: DatePresetId | null
  onToggleType: (type: ContentType) => void
  onToggleDate: (id: DatePresetId) => void
  onPickTag: () => void
}

const ActiveMark = ({ active }: { active: boolean }): React.JSX.Element | null =>
  active ? <Check className="size-3.5 text-foreground" aria-hidden="true" /> : null

export function SearchFilterMenu({
  entries,
  activeTypes,
  activeDate,
  onToggleType,
  onToggleDate,
  onPickTag
}: SearchFilterMenuProps): React.JSX.Element {
  const { t, i18n } = useT('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  return (
    <>
      {entries.types.length > 0 && (
        <Command.Group heading={<SearchGroupHeading label={t('searchPalette.filterType')} />}>
          {entries.types.map((type) => {
            const Icon = TYPE_ICONS[type]
            return (
              <SearchRow
                key={type}
                value={filterTypeValue(type)}
                onSelect={() => onToggleType(type)}
                icon={<Icon />}
                trailing={<SearchKbd>{`${MOD_KEY}${TYPE_SHORTCUTS[type]}`}</SearchKbd>}
                endLane={<ActiveMark active={activeTypes.includes(type)} />}
              >
                {t(TYPE_LABEL_KEYS[type])}
              </SearchRow>
            )
          })}
        </Command.Group>
      )}
      {entries.dates.length > 0 && (
        <Command.Group heading={<SearchGroupHeading label={t('searchPalette.filterModified')} />}>
          {entries.dates.map((id) => (
            <SearchRow
              key={id}
              value={filterDateValue(id)}
              onSelect={() => onToggleDate(id)}
              icon={<Calendar />}
              trailing={datePresetSpan(id, locale)}
              endLane={<ActiveMark active={activeDate === id} />}
            >
              {t(DATE_LABEL_KEYS[id])}
            </SearchRow>
          ))}
        </Command.Group>
      )}
      {entries.tag && (
        <Command.Group heading={<SearchGroupHeading label={t('searchPalette.tag')} />}>
          <SearchRow
            value={FILTER_TAG_VALUE}
            onSelect={onPickTag}
            icon={<Hash />}
            trailing={<SearchKbd>{'#'}</SearchKbd>}
            endLane={null}
          >
            {t('searchPalette.chooseTag')}
          </SearchRow>
        </Command.Group>
      )}
    </>
  )
}
