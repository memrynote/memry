import { useState, useCallback, useMemo } from 'react'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { Picker } from '@/components/ui/picker'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TagChip, Tag } from './TagChip'
import { defaultTagColorName } from './tag-colors'
import { useT } from '@memry/i18n/renderer'
import { CornerDownLeft, List, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import { tagDisplayName } from '@/features/tag-fields/tag-display-name'

export interface TagFieldHints {
  bodyEmpty: boolean
  tags: Readonly<Record<string, ResolvedTag>>
}

interface TagInputPopupProps {
  availableTags: Tag[]
  recentTags: Tag[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  fieldHints?: TagFieldHints
  children: React.ReactNode
}

export function TagInputPopup({
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled = false,
  fieldHints,
  children
}: TagInputPopupProps) {
  const { t } = useT('notes')
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next)
      controlledOnOpenChange?.(next)
      if (!next) {
        setSearchQuery('')
        setFocusedIndex(-1)
      }
    },
    [controlledOnOpenChange, controlledOpen]
  )

  const matchingTags = useMemo(() => {
    const base = searchQuery.trim()
      ? availableTags.filter((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : availableTags
    return base.filter((t) => !currentTagIds.includes(t.id))
  }, [availableTags, searchQuery, currentTagIds])

  const fieldRows = useMemo(() => {
    if (!fieldHints || !searchQuery.trim()) return []
    return matchingTags.flatMap((tag) => {
      const resolved = fieldHints.tags[tag.name.toLowerCase()]
      return resolved?.hasFields ? [{ tag, resolved }] : []
    })
  }, [fieldHints, searchQuery, matchingTags])

  const filteredTags = useMemo(() => {
    if (fieldRows.length === 0) return matchingTags
    const rowIds = new Set(fieldRows.map((row) => row.tag.id))
    return [...fieldRows.map((row) => row.tag), ...matchingTags.filter((t) => !rowIds.has(t.id))]
  }, [fieldRows, matchingTags])
  const chipTags = filteredTags.slice(fieldRows.length)
  const activeIndex = focusedIndex === -1 && fieldRows.length > 0 ? 0 : focusedIndex

  const exactMatchExists = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return availableTags.some((tag) => tag.name.toLowerCase() === query)
  }, [availableTags, searchQuery])

  const filteredRecentTags = useMemo(
    () => recentTags.filter((tag) => !currentTagIds.includes(tag.id)),
    [recentTags, currentTagIds]
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    setFocusedIndex(-1)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(() => (activeIndex < filteredTags.length - 1 ? activeIndex + 1 : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(() => (activeIndex > 0 ? activeIndex - 1 : filteredTags.length - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (activeIndex >= 0 && activeIndex < filteredTags.length) {
          onAddTag(filteredTags[activeIndex].id)
          handleOpenChange(false)
          return
        }
        const trimmed = searchQuery.trim()
        if (trimmed) {
          if (!exactMatchExists) {
            onCreateTag(trimmed, defaultTagColorName(trimmed))
            handleOpenChange(false)
          } else if (filteredTags.length > 0) {
            onAddTag(filteredTags[0].id)
            handleOpenChange(false)
          }
        }
      }
    },
    [
      searchQuery,
      exactMatchExists,
      onCreateTag,
      filteredTags,
      onAddTag,
      activeIndex,
      handleOpenChange
    ]
  )

  const handleTagClick = useCallback(
    (tag: Tag) => {
      onAddTag(tag.id)
      handleOpenChange(false)
    },
    [onAddTag, handleOpenChange]
  )

  return (
    <Picker open={open} onOpenChange={handleOpenChange} closeOnSelect={false}>
      <Picker.Trigger asChild disabled={disabled}>
        {children}
      </Picker.Trigger>
      <Picker.Content
        width={fieldHints ? 340 : 280}
        align="start"
        sideOffset={8}
        onKeyDown={handleKeyDown}
      >
        <FilterSearchHeader
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder={t('tagsRow.inputPlaceholder')}
        />

        <ScrollArea className="max-h-[260px]">
          <Picker.List className="flex-wrap gap-1.5">
            {filteredRecentTags.length > 0 && !searchQuery && (
              <Picker.Section label={t('tagsRow.recent')}>
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {filteredRecentTags.slice(0, 8).map((tag) => (
                    <TagChip key={tag.id} tag={tag} onClick={() => handleTagClick(tag)} />
                  ))}
                </div>
              </Picker.Section>
            )}

            {fieldRows.length > 0 && (
              <div className="flex flex-col gap-0.5 px-1 pb-1" role="listbox">
                {fieldRows.map((row, index) => (
                  <FieldTagRow
                    key={row.tag.id}
                    tag={row.tag}
                    resolved={row.resolved}
                    bodyEmpty={fieldHints?.bodyEmpty ?? false}
                    active={index === activeIndex}
                    onPick={() => handleTagClick(row.tag)}
                  />
                ))}
              </div>
            )}

            {chipTags.length > 0 && (
              <Picker.Section label={searchQuery ? t('tagsRow.matching') : t('tagsRow.all')}>
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {chipTags.map((tag, index) => (
                    <TagChip
                      key={tag.id}
                      tag={tag}
                      isFocused={index + fieldRows.length === activeIndex}
                      onClick={() => handleTagClick(tag)}
                    />
                  ))}
                </div>
              </Picker.Section>
            )}

            {filteredTags.length === 0 && searchQuery && !fieldHints && (
              <Picker.Empty message={t('tagsRow.none')} />
            )}

            {fieldHints && searchQuery.trim() && !exactMatchExists && (
              <button
                type="button"
                className="mx-1 mt-1 flex items-center gap-2 rounded-[5px] border-t border-border/60 px-2 py-1.5 text-start text-[13px] text-foreground hover:bg-accent"
                onClick={() => {
                  const trimmed = searchQuery.trim()
                  onCreateTag(trimmed, defaultTagColorName(trimmed))
                  handleOpenChange(false)
                }}
              >
                <Plus className="size-3.5 text-text-tertiary" aria-hidden="true" />
                {t('tagFields.picker.create', { tag: searchQuery.trim() })}
              </button>
            )}
          </Picker.List>
        </ScrollArea>
      </Picker.Content>
    </Picker>
  )
}

function FieldTagRow({
  tag,
  resolved,
  bodyEmpty,
  active,
  onPick
}: {
  tag: Tag
  resolved: ResolvedTag
  bodyEmpty: boolean
  active: boolean
  onPick: () => void
}) {
  const { t } = useT('notes')
  const fills = bodyEmpty && resolved.template?.autofill
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[5px] px-2 py-1.5 text-start',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      <TagChip tag={{ ...tag, icon: resolved.icon ?? tag.icon }} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-[12.5px] text-foreground">
          <List className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="truncate">
            {resolved.effectiveFields.map((field) => field.name).join(', ')}
          </span>
        </span>
        {fills && (
          <span className="text-[12px] text-text-tertiary">
            {t('tagFields.picker.fillsTemplate', { tag: tagDisplayName(resolved.name) })}
          </span>
        )}
      </span>
      {active && (
        <kbd className="flex size-4 shrink-0 items-center justify-center rounded border border-border text-text-tertiary">
          <CornerDownLeft className="size-2.5" aria-hidden="true" />
        </kbd>
      )}
    </button>
  )
}
