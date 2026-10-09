import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ObjectMatch } from '@memry/contracts/tag-objects-api'
import { formatRelationUri } from '@memry/contracts/relation-uri'
import { Check, Plus, Search } from '@/lib/icons'
import { tagsService } from '@/services/tags-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toast } from 'sonner'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { ObjectAvatar, TagGlyph } from './object-avatar'
import { useTagLookLookup } from './object-look'
import { createObject } from './create-object'

const log = createLogger('ObjectRelationPicker')
const DEBOUNCE_MS = 120

/** Objects of `tag` (and the tags that extend it) matching `query`, newest activity first. */
export function useObjectSearch(
  query: string,
  tag: string | undefined,
  limit = 12
): { matches: ObjectMatch[]; loading: boolean } {
  const [state, setState] = useState<{ matches: ObjectMatch[]; loading: boolean }>({
    matches: [],
    loading: true
  })
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      tagsService
        .searchObjects({ query, limit, ...(tag && { tag }) })
        .then((result) => {
          if (!cancelled) setState({ matches: result.matches, loading: false })
        })
        .catch((error: unknown) => {
          log.error('object search failed', extractErrorMessage(error))
          if (!cancelled) setState({ matches: [], loading: false })
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, tag, limit])
  return state
}

/**
 * E2: a relation field with a target tag only offers notes with that tag.
 * Picking writes the same `memry://note/<id>` URI the generic picker writes;
 * "+ New {tag}" creates the object in place (with the tag and its template).
 */
export function ObjectRelationPicker({
  targetTag,
  selected = [],
  onSelect
}: {
  targetTag: string
  /** URIs already in the value: shown with a check. */
  selected?: readonly string[]
  onSelect: (uri: string) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const { matches, loading } = useObjectSearch(query, targetTag)
  const lookOf = useTagLookLookup()
  const targetLook = lookOf(targetTag)
  const tagColor = getTagColors(targetLook?.color ?? '', targetTag).text
  const tagName = targetTag

  const create = async (): Promise<void> => {
    const title = query.trim() || t('tagObjects.picker.untitled', { tag: tagName })
    try {
      const created = await createObject({ title, tag: targetTag })
      onSelect(formatRelationUri('note', created.id))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('tagObjects.create.failed')))
    }
  }

  const count = matches.length + 1
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + step + count) % count)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const match = matches[active]
      if (match) onSelect(formatRelationUri('note', match.noteId))
      else void create()
    }
  }

  return (
    <div
      className="flex w-[300px] flex-col text-[13px] leading-4 [font-synthesis:none]"
      data-testid="object-relation-picker"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search size={12} className="shrink-0 text-muted-foreground/60" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={t('tagObjects.picker.search', { tag: tagName })}
          aria-label={t('tagObjects.picker.search', { tag: tagName })}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: withAlpha(tagColor, 0.12), color: tagColor }}
        >
          {targetLook && <TagGlyph look={targetLook} className="size-3" />}
          {tagName}
        </span>
      </div>
      <div role="listbox" className="flex max-h-72 flex-col overflow-y-auto p-1">
        {matches.map((match, index) => {
          const uri = formatRelationUri('note', match.noteId)
          const look = lookOf(match.tag)
          return (
            <button
              key={match.noteId}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelect(uri)}
              className={`flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-start ${index === active ? 'bg-accent' : ''}`}
            >
              {look && <ObjectAvatar look={look} title={match.title} size={24} />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium text-foreground">{match.title}</span>
                {match.subtitle.length > 0 && (
                  <span className="truncate text-xs text-muted-foreground">
                    {match.subtitle.join(' · ')}
                  </span>
                )}
              </span>
              {selected.includes(uri) && <Check className="size-3.5 shrink-0" />}
            </button>
          )
        })}
        {!loading && matches.length === 0 && query.trim() !== '' && (
          <div className="px-2 py-1.5 text-muted-foreground">{t('tagObjects.picker.empty')}</div>
        )}
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          onMouseEnter={() => setActive(matches.length)}
          onClick={() => void create()}
          className={`flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-start ${active === matches.length ? 'bg-accent' : ''}`}
        >
          <Plus className="size-3.5 text-muted-foreground" />
          <span>
            {query.trim()
              ? t('tagObjects.picker.createNamed', { title: query.trim(), tag: tagName })
              : t('tagObjects.picker.create', { tag: tagName })}
          </span>
        </button>
      </div>
    </div>
  )
}
