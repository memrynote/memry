import { useState, useEffect } from 'react'
import { Plus, Trash2 } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { getTagColors, COLOR_NAMES } from '../../tags-row/tag-colors'
import { SelectChip } from './SelectChip'
import type {
  StatusCategories,
  StatusCategoryKey,
  SelectOption,
  STATUS_CATEGORY_KEYS
} from '@memry/contracts/property-types'

interface StatusEditorProps {
  value: string | null
  categories: StatusCategories
  defaultOpen?: boolean
  onChange: (value: string | null) => void
  onAddOption?: (categoryKey: StatusCategoryKey, option: SelectOption) => void
  onRemoveOption?: (optionValue: string) => void
}

const CATEGORY_ORDER: StatusCategoryKey[] = ['todo', 'in_progress', 'done']

export function StatusEditor({
  value,
  categories,
  defaultOpen,
  onChange,
  onAddOption,
  onRemoveOption
}: StatusEditorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false)
  const [creatingInCategory, setCreatingInCategory] = useState<StatusCategoryKey | null>(null)
  const [newOptionName, setNewOptionName] = useState('')

  useEffect(() => {
    if (defaultOpen) setIsOpen(true)
  }, [defaultOpen])

  const allOptions = CATEGORY_ORDER.flatMap((key) => categories[key].options)
  const selectedOption = allOptions.find((o) => o.value === value)
  const isOrphan = value && !selectedOption

  const handleAddOption = (categoryKey: StatusCategoryKey) => {
    if (!newOptionName.trim()) return
    const categoryOptions = categories[categoryKey].options
    const color = COLOR_NAMES[categoryOptions.length % COLOR_NAMES.length]
    const option: SelectOption = { value: newOptionName.trim(), color }
    onAddOption?.(categoryKey, option)
    onChange(option.value)
    setNewOptionName('')
    setCreatingInCategory(null)
  }

  return (
    <Picker
      open={isOpen}
      onOpenChange={setIsOpen}
      value={value}
      onValueChange={(val) => onChange(val === value ? null : val)}
    >
      <Picker.Trigger variant="inline" asChild>
        <span>
          {selectedOption ? (
            <SelectChip value={selectedOption.value} color={selectedOption.color} />
          ) : isOrphan ? (
            <SelectChip value={String(value)} color="stone" />
          ) : (
            <span className="text-[13px] text-text-tertiary font-sans">Empty</span>
          )}
        </span>
      </Picker.Trigger>
      <Picker.Content width={220} align="start">
        <Picker.List>
          {CATEGORY_ORDER.map((categoryKey) => {
            const category = categories[categoryKey]
            return (
              <Picker.Section key={categoryKey} label={category.label}>
                {category.options.map((opt) => (
                  <Picker.Item
                    key={opt.value}
                    value={opt.value}
                    label={opt.value}
                    indicator="dot"
                    indicatorColor={getTagColors(opt.color).text}
                    trailing={
                      onRemoveOption ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (value === opt.value) onChange(null)
                            onRemoveOption(opt.value)
                          }}
                          className="p-0.5 rounded text-muted-foreground/30 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      ) : undefined
                    }
                  />
                ))}
                {creatingInCategory === categoryKey ? (
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{
                        backgroundColor: getTagColors(
                          COLOR_NAMES[category.options.length % COLOR_NAMES.length]
                        ).text
                      }}
                    />
                    <input
                      autoFocus
                      type="text"
                      value={newOptionName}
                      onChange={(e) => setNewOptionName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddOption(categoryKey)
                        } else if (e.key === 'Escape') {
                          setCreatingInCategory(null)
                          setNewOptionName('')
                        }
                      }}
                      onBlur={() => {
                        if (!newOptionName.trim()) setCreatingInCategory(null)
                      }}
                      placeholder="Option name"
                      className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setCreatingInCategory(categoryKey)
                    }}
                    className="flex items-center gap-2 w-full px-2 py-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent rounded-[5px]"
                  >
                    <Plus className="size-3" />
                    Add
                  </button>
                )}
              </Picker.Section>
            )
          })}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
