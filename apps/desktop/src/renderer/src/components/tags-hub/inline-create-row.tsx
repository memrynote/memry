import * as React from 'react'
import { useState, useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'

export interface InlineCreateRowProps {
  onCreateCategory: (name: string) => Promise<void>
  onCreateTag: (name: string, color: string, categoryId: string | null) => Promise<void>
  categoryId?: string | null
}

type Mode = 'idle' | 'category' | 'tag'

/**
 * Tag hub create affordances: "New category" opens an inline name input;
 * "New tag" opens a name input plus a color palette (`COLOR_NAMES`). No
 * dialogs — Enter submits, Escape cancels back to idle. `categoryId` (absent
 * for the page-bottom instance, meaning uncategorized) threads straight into
 * `onCreateTag`.
 */
export function InlineCreateRow({
  onCreateCategory,
  onCreateTag,
  categoryId = null
}: InlineCreateRowProps): React.JSX.Element {
  const { t } = useT('notes')
  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLOR_NAMES[0])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode !== 'idle') {
      inputRef.current?.focus()
    }
  }, [mode])

  const reset = (): void => {
    setMode('idle')
    setName('')
    setColor(COLOR_NAMES[0])
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
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setMode('category')}>
          <Plus className="me-1.5 h-3.5 w-3.5" />
          {t('tagsHub.newCategory')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMode('tag')}>
          <Plus className="me-1.5 h-3.5 w-3.5" />
          {t('tagsHub.newTag')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
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
        className="w-48"
      />
      {mode === 'tag' && (
        <div className="flex flex-wrap gap-1.5">
          {COLOR_NAMES.map((colorName) => {
            const isSelected = color === colorName
            return (
              <button
                key={colorName}
                type="button"
                aria-label={t('tagsRow.colorAria', { color: colorName })}
                aria-pressed={isSelected}
                onClick={() => setColor(colorName)}
                className={cn(
                  'h-5 w-5 rounded-full transition-transform hover:scale-110',
                  isSelected && 'ring-2 ring-offset-1 ring-offset-background'
                )}
                style={{ backgroundColor: getTagColors(colorName).background }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export default InlineCreateRow
