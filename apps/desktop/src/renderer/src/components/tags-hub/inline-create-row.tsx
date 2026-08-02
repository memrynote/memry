import * as React from 'react'
import { useState, useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tag, Tags, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { COLOR_NAMES, COLOR_ROWS, getTagColors } from '@/components/note/tags-row/tag-colors'
import { CustomColorSwatch } from '@/components/note/tags-row/CustomColorSwatch'

/**
 * A new tag gets a colour without being asked for one. Showing all ~20
 * swatches up front pushed the input's row down and made picking a colour feel
 * mandatory; a random assignment covers the common case, and the swatch in the
 * input opens the full palette for anyone who cares.
 */
const randomColorName = (): string =>
  COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)] ?? COLOR_NAMES[0]

export interface InlineCreateRowProps {
  onCreateCategory: (name: string) => Promise<void>
  onCreateTag: (name: string, color: string, categoryId: string | null) => Promise<void>
  categoryId?: string | null
}

type Mode = 'idle' | 'category' | 'tag'

/**
 * Same chromeless treatment as the hub's search field: icon and label only,
 * sitting on the page background, earning a hairline on hover and a slightly
 * firmer one while focused. The border is always present but transparent so
 * gaining it shifts nothing, and the ghost variant's hover fill is suppressed
 * — the border alone carries the state.
 */
const CHROMELESS_BUTTON =
  'border border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-transparent hover:text-foreground focus-visible:border-ring focus-visible:ring-0'

/**
 * Tag hub create affordances: "New category" opens an inline name input;
 * "New tag" opens a name input that already carries a randomly assigned
 * colour, with a swatch inside the field opening the full palette (plus the
 * custom-hex swatch) for anyone who wants to change it. No dialogs — Enter
 * submits, Escape or the trailing ✕ cancels back to idle. `categoryId`
 * (absent for the page-bottom instance, meaning uncategorized) threads
 * straight into `onCreateTag`.
 */
export function InlineCreateRow({
  onCreateCategory,
  onCreateTag,
  categoryId = null
}: InlineCreateRowProps): React.JSX.Element {
  const { t } = useT('notes')
  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [color, setColor] = useState(randomColorName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode !== 'idle') {
      inputRef.current?.focus()
    }
  }, [mode])

  const reset = (): void => {
    setMode('idle')
    setName('')
    setColor(randomColorName())
  }

  const handleSubmit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (mode === 'category') {
      await onCreateCategory(trimmed)
    } else if (mode === 'tag') {
      await onCreateTag(trimmed, color, categoryId)
    }
    reset()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleSubmit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      reset()
    }
  }

  if (mode === 'idle') {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className={CHROMELESS_BUTTON}
          onClick={() => setMode('category')}
        >
          <Tags className="me-1.5 h-3.5 w-3.5" />
          {t('tagsHub.newCategory')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={CHROMELESS_BUTTON}
          onClick={() => setMode('tag')}
        >
          <Tag className="me-1.5 h-3.5 w-3.5" />
          {t('tagsHub.newTag')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Everything stays on one row: the colour swatch and the ✕ sit inside
          the field's padding rather than stacking beneath it, so opening the
          create affordance never shifts the rows below. Escape still cancels;
          the ✕ just gives that exit a visible target. */}
      <div className={cn('relative', mode === 'tag' ? 'w-56' : 'w-48')}>
        {mode === 'tag' && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('tagsRow.chooseColor')}
                className="absolute start-1.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ backgroundColor: getTagColors(color).background }}
              />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <div className="space-y-1.5">
                {COLOR_ROWS.map((row, rowIndex) => (
                  <div key={rowIndex} className="flex gap-1.5">
                    {row.map((colorName) => (
                      <button
                        key={colorName}
                        type="button"
                        aria-label={t('tagsRow.colorAria', { color: colorName })}
                        aria-pressed={color === colorName}
                        onClick={() => setColor(colorName)}
                        className={cn(
                          'h-6 w-6 rounded-full transition-transform hover:scale-110',
                          color === colorName &&
                            'ring-2 ring-ring ring-offset-1 ring-offset-background'
                        )}
                        style={{ backgroundColor: getTagColors(colorName).background }}
                      />
                    ))}
                    {rowIndex === COLOR_ROWS.length - 1 && (
                      <CustomColorSwatch size="sm" value={color} onChange={setColor} />
                    )}
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        <Input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === 'category'
              ? t('tagsHub.categoryNamePlaceholder')
              : t('tagsHub.tagNamePlaceholder')
          }
          className={cn('w-full pe-8', mode === 'tag' && 'ps-9')}
        />
        <button
          type="button"
          aria-label={t('tagsHub.cancelCreate')}
          onClick={reset}
          className="absolute end-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

export default InlineCreateRow
