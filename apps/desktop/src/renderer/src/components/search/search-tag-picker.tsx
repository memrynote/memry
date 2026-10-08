import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { getTagColors } from '@memry/contracts/tag-colors'
import type { TagWithCount } from '@memry/contracts/tags-api'
import { useT } from '@memry/i18n/renderer'
import { tagsService } from '@/services/tags-service'
import { createLogger } from '@/lib/logger'
import { HighlightedText, SearchCount, SearchGroupHeading, SearchRow } from './search-row'

const log = createLogger('SearchTagPicker')
const MAX_TAGS = 50

export const tagValue = (name: string): string => `tag:${name}`

/** Every tag with its item count, loaded once per palette session. */
export function useSearchTags(enabled: boolean): TagWithCount[] {
  const [tags, setTags] = useState<TagWithCount[] | null>(null)
  useEffect(() => {
    if (!enabled || tags) return
    let cancelled = false
    tagsService
      .getAllWithCounts()
      .then(({ tags: all }) => {
        if (!cancelled) setTags(all)
      })
      .catch((err) => log.warn('Failed to load tags for search', err))
    return () => {
      cancelled = true
    }
  }, [enabled, tags])
  return tags ?? []
}

/** Tags matching what was typed after "#", minus the ones already applied. */
export function matchingTags(
  tags: TagWithCount[],
  menuQuery: string,
  active: string[]
): TagWithCount[] {
  const q = menuQuery.trim().toLowerCase()
  return tags
    .filter((tag) => !active.includes(tag.name) && tag.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return aPrefix - bPrefix || b.count - a.count
    })
    .slice(0, MAX_TAGS)
}

interface SearchTagPickerProps {
  tags: TagWithCount[]
  menuQuery: string
  onPick: (name: string) => void
}

export function SearchTagPicker({
  tags,
  menuQuery,
  onPick
}: SearchTagPickerProps): React.JSX.Element {
  const { t } = useT('common')
  if (tags.length === 0) {
    return (
      <p className="px-2.5 py-8 text-center text-[13px] text-text-tertiary">
        {t('searchPalette.noTags')}
      </p>
    )
  }
  return (
    <Command.Group
      heading={
        <SearchGroupHeading
          label={t('searchPalette.tags')}
          trailing={<span>{t('searchPalette.items')}</span>}
        />
      }
    >
      {tags.map((tag) => (
        <SearchRow
          key={tag.name}
          value={tagValue(tag.name)}
          onSelect={() => onPick(tag.name)}
          icon={
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: getTagColors(tag.color ?? '', tag.name).background }}
            />
          }
          trailing={<SearchCount value={tag.count} />}
        >
          <span className="text-text-tertiary">{'#'}</span>
          <HighlightedText text={tag.name} query={menuQuery} />
        </SearchRow>
      ))}
    </Command.Group>
  )
}
