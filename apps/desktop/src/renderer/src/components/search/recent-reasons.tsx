import { Command } from 'cmdk'
import { Hash } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { ContentType, SearchReason } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { SearchGroupHeading, SearchKbd, SearchRow } from './search-row'
import { CONTENT_TYPES, MOD_KEY, TYPE_ICONS, TYPE_LABEL_KEYS, TYPE_SHORTCUTS } from './search-types'

interface RecentReasonsProps {
  reasons: SearchReason[]
  onSelect: (reason: SearchReason) => void
  onClear: () => void
  onScope: (type: ContentType) => void
  onPickTag: () => void
}

export const reasonValue = (reason: SearchReason): string => `reason:${reason.id}`
export const scopeValue = (type: ContentType): string => `scope:${type}`
export const PICK_TAG_VALUE = 'scope:tag'

/** The palette before the first keystroke: the recent trail, then where to search. */
export function RecentReasons({
  reasons,
  onSelect,
  onClear,
  onScope,
  onPickTag
}: RecentReasonsProps): React.JSX.Element {
  const { t } = useT('common')
  return (
    <>
      {reasons.length > 0 && (
        <Command.Group
          heading={
            <SearchGroupHeading
              label={t('searchPalette.recent')}
              trailing={
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={onClear}
                  className="rounded-sm text-[11px] text-text-tertiary hover:text-foreground"
                >
                  {t('searchPalette.clear')}
                </button>
              }
            />
          }
        >
          {reasons.map((reason) => {
            const Icon = TYPE_ICONS[reason.itemType] ?? TYPE_ICONS.note
            return (
              <SearchRow
                key={reason.id}
                value={reasonValue(reason)}
                onSelect={() => onSelect(reason)}
                icon={
                  reason.itemIcon ? (
                    <NoteIconDisplay
                      value={reason.itemIcon}
                      className="flex size-3.5 items-center justify-center text-sm leading-none"
                    />
                  ) : (
                    <Icon />
                  )
                }
                trailing={t('searchPalette.fromQuery', { query: reason.searchQuery })}
              >
                {reason.itemTitle}
              </SearchRow>
            )
          })}
        </Command.Group>
      )}
      <Command.Group heading={<SearchGroupHeading label={t('searchPalette.searchIn')} />}>
        {CONTENT_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type]
          return (
            <SearchRow
              key={type}
              value={scopeValue(type)}
              onSelect={() => onScope(type)}
              icon={<Icon />}
              trailing={<SearchKbd>{`${MOD_KEY}${TYPE_SHORTCUTS[type]}`}</SearchKbd>}
            >
              {t(TYPE_LABEL_KEYS[type])}
            </SearchRow>
          )
        })}
        <SearchRow
          value={PICK_TAG_VALUE}
          onSelect={onPickTag}
          icon={<Hash />}
          trailing={<SearchKbd>{'#'}</SearchKbd>}
        >
          {t('searchPalette.tag')}
        </SearchRow>
      </Command.Group>
    </>
  )
}
