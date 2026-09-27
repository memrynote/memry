import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Hash } from '@/lib/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { PropertyChip, stopKeyPropagation } from './property-chip'
import { shortcutLabelFor, type TaskPropertyOpenState } from './task-property-ids'

/** Past this many the chip ends in "+N"; the picker lists them all. */
const MAX_VISIBLE_TAGS = 2

interface TagsChipProps extends TaskPropertyOpenState {
  tags: string[]
  onChange: (tags: string[]) => void
}

/**
 * The task's tags as one chip, each in the colour the user gave it. The
 * picker is the drawer's tag field: removable pills, search, create.
 */
export const TagsChip = ({
  tags,
  onChange,
  open,
  onOpenChange
}: TagsChipProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const { tags: tagDefs } = useNoteTagsQuery({ enabled: tags.length > 0 })
  const colorByName = useMemo(
    () => new Map(tagDefs.map((def) => [def.tag.toLowerCase(), def.color ?? ''])),
    [tagDefs]
  )

  const isOpen = open === 'tags'
  if (tags.length === 0 && !isOpen) return null

  const visible = tags.slice(0, MAX_VISIBLE_TAGS)
  const overflow = tags.length - visible.length

  return (
    <Popover open={isOpen} onOpenChange={(next) => onOpenChange('tags', next)}>
      <PopoverTrigger asChild>
        <PropertyChip
          icon={
            tags.length === 0 ? <Hash className="size-3 shrink-0" aria-hidden="true" /> : undefined
          }
          aria-label={tags.length > 0 ? `${t('task.tags')}: ${tags.join(', ')}` : t('task.tags')}
          title={`${t('task.tags')} · ${shortcutLabelFor('tags')}`}
          className="gap-1.5"
        >
          {tags.length === 0 ? (
            t('task.tags')
          ) : (
            <span className="flex items-center gap-1.5">
              {visible.map((tag) => {
                const colors = getTagColors(colorByName.get(tag.toLowerCase()) ?? '', tag)
                return (
                  <span key={tag} className="flex min-w-0 items-center gap-1">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colors.text }}
                      aria-hidden="true"
                    />
                    <span className="max-w-24 truncate">{tag}</span>
                  </span>
                )
              })}
              {overflow > 0 && <span className="tabular-nums text-text-tertiary">+{overflow}</span>}
            </span>
          )}
        </PropertyChip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 overflow-visible p-1.5"
        onKeyDown={stopKeyPropagation}
        // The field focuses its own input; Radix would otherwise land on the
        // first pill's remove button.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <TagAutocomplete tags={tags} onTagsChange={onChange} variant="row" autoFocus />
      </PopoverContent>
    </Popover>
  )
}
