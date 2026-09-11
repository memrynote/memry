/**
 * Tag Value Input
 *
 * The value field of a `tags` filter condition. It is a plain text input — the
 * filter expression still stores a bare string — with a suggestion list over
 * the vault's tags so the name never has to be recalled from memory: focus
 * offers the most-used tags, every keystroke re-ranks, arrows move and Enter
 * commits the highlighted tag into the input.
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { rankTagSuggestions, type TagSuggestion } from '@/lib/tag-suggestions'
import { useT } from '@memry/i18n/renderer'

/** Most-used tags offered on focus, before anything is typed. */
const FOCUS_LIMIT = 5
/** Cap while searching — enough to scan, short enough to stay a menu. */
const SEARCH_LIMIT = 8

interface TagValueInputProps {
  /** Current condition value (a bare tag string). */
  value: string
  /** Called on every keystroke and on suggestion pick. */
  onChange: (value: string) => void
  /** Vault tags to suggest; empty means the input behaves as plain text. */
  suggestions: readonly TagSuggestion[]
  placeholder: string
}

export function TagValueInput({
  value,
  onChange,
  suggestions,
  placeholder
}: TagValueInputProps): React.JSX.Element {
  const { t } = useT('notes')
  const listId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo(
    () => rankTagSuggestions(suggestions, value, value.trim() ? SEARCH_LIMIT : FOCUS_LIMIT),
    [suggestions, value]
  )

  // Clamped on render rather than reset in an effect: the list changes with
  // every keystroke, and a stale index must never point past its end.
  const activeIndex = items.length === 0 ? -1 : Math.min(highlight, items.length - 1)
  const showList = isOpen && items.length > 0

  const commit = useCallback(
    (tag: TagSuggestion) => {
      onChange(tag.name)
      // Focus first, close second: a picked-by-mouse commit refocuses the
      // input, and that focus event asks to re-open. Closing after it means
      // the list stays shut whichever way the tag was picked.
      inputRef.current?.focus()
      setIsOpen(false)
      setHighlight(0)
    },
    [onChange]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (items.length === 0) return
        event.preventDefault()
        if (!isOpen) {
          setIsOpen(true)
          return
        }
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setHighlight((current) => {
          const next = (Math.min(current, items.length - 1) + delta + items.length) % items.length
          return next
        })
        return
      }

      if (event.key === 'Enter') {
        if (!showList || activeIndex < 0) return
        // Stop here: the surrounding filter popover treats Enter as "done".
        event.preventDefault()
        event.stopPropagation()
        commit(items[activeIndex])
        return
      }

      if (event.key === 'Escape' && showList) {
        // Close the list only — the filter popover stays open.
        event.preventDefault()
        event.stopPropagation()
        setIsOpen(false)
        return
      }

      if (event.key === 'Tab') setIsOpen(false)
    },
    [activeIndex, commit, isOpen, items, showList]
  )

  return (
    // The list is portalled rather than absolutely positioned: this input
    // lives inside the filter popover, whose content is `overflow-clip`, so an
    // in-flow dropdown is cut off at the popover's edge. Anchoring it the way
    // the sibling date picker does puts it above everything.
    <Popover open={showList}>
      <PopoverAnchor asChild>
        <div className="flex-1 min-w-0">
          <Input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={placeholder}
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={
              showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
              setHighlight(0)
              setIsOpen(true)
            }}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setIsOpen(false)}
            onKeyDown={handleKeyDown}
            className="h-[26px] w-full min-w-0 rounded-md border-border bg-transparent px-2 text-[11.5px] text-foreground"
            placeholder={placeholder}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={4}
        // Typing is the interaction — the list must never take the caret.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // Keep the input focused: blur would close the list before a click
        // lands, so the pick would never happen.
        onMouseDown={(event) => event.preventDefault()}
        className="max-h-56 w-[200px] overflow-y-auto p-1"
      >
        <ul
          id={listId}
          role="listbox"
          aria-label={t('phaseF.componentsFolderViewFilterRow.tagSuggestions')}
        >
          {items.map((tag, index) => {
            const colors = getTagColors(tag.color ?? '', tag.name)
            return (
              <li key={tag.name.toLowerCase()}>
                <button
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => commit(tag)}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-start outline-none',
                    index === activeIndex && 'bg-accent'
                  )}
                >
                  <span
                    className="min-w-0 truncate rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                    style={{ backgroundColor: withAlpha(colors.text, 0.12), color: colors.text }}
                  >
                    {tag.name}
                  </span>
                  <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                    {tag.count}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export default TagValueInput
