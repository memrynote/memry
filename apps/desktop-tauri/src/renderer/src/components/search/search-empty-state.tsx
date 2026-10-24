import { Command } from 'cmdk'
import { useT } from '@memry/i18n/renderer'

export const SEARCH_EVERYWHERE_VALUE = 'empty:everywhere'
export const CLEAR_FILTERS_VALUE = 'empty:clear'

export function emptyStateValues(hasTypes: boolean, hasFilters: boolean): string[] {
  return [
    ...(hasTypes ? [SEARCH_EVERYWHERE_VALUE] : []),
    ...(hasFilters ? [CLEAR_FILTERS_VALUE] : [])
  ]
}

interface SearchEmptyStateProps {
  query: string
  /** Translated names of the active type filters, empty for an unscoped search. */
  scopeLabels: string[]
  hasFilters: boolean
  indexing: boolean
  onSearchEverywhere: () => void
  onClearFilters: () => void
}

const ACTION_CLASS =
  'flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs leading-4 text-text-secondary data-[selected=true]:bg-surface-active data-[selected=true]:font-medium data-[selected=true]:text-foreground'

export function SearchEmptyState({
  query,
  scopeLabels,
  hasFilters,
  indexing,
  onSearchEverywhere,
  onClearFilters
}: SearchEmptyStateProps): React.JSX.Element {
  const { t, i18n } = useT('common')
  const scope = new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, {
    type: 'disjunction'
  }).format(scopeLabels)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 pb-10 text-center">
      <p className="text-sm font-medium leading-5 text-foreground">
        {scopeLabels.length > 0
          ? t('searchPalette.empty.scoped', { scope, query })
          : t('searchPalette.empty.unscoped', { query })}
      </p>
      <p className="text-[13px] leading-[18px] text-text-tertiary">
        {indexing
          ? t('searchPalette.empty.indexing')
          : hasFilters
            ? t('searchPalette.empty.tryFilters')
            : t('searchPalette.empty.tryWords')}
      </p>
      {hasFilters && (
        <Command.Group className="pt-3.5 [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:gap-1.5">
          {scopeLabels.length > 0 && (
            <Command.Item
              value={SEARCH_EVERYWHERE_VALUE}
              onSelect={onSearchEverywhere}
              className={ACTION_CLASS}
            >
              {t('searchPalette.actions.searchEverywhere')}
            </Command.Item>
          )}
          <Command.Item
            value={CLEAR_FILTERS_VALUE}
            onSelect={onClearFilters}
            className={ACTION_CLASS}
          >
            {t('searchPalette.actions.clearFilters')}
          </Command.Item>
        </Command.Group>
      )}
    </div>
  )
}
