import { useState } from 'react'
import { Plus, Trash2 } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { getTagColors, COLOR_NAMES } from '../../tags-row/tag-colors'
import { SelectChip } from './SelectChip'
import type { SelectOption } from '@memry/contracts/property-types'

interface MultiselectEditorProps {
  value: string[]
  options: SelectOption[]
  defaultOpen?: boolean
  onChange: (value: string[]) => void
  onAddOption?: (option: SelectOption) => void
  onRemoveOption?: (optionValue: string) => void
}

export function MultiselectEditor({
  value,
  options,
  defaultOpen,
  onChange,
  onAddOption,
  onRemoveOption
}: MultiselectEditorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false)
  const [newOptionName, setNewOptionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const selectedOptions = value
    .map((v) => options.find((o) => o.value === v))
    .filter(Boolean) as SelectOption[]
  const orphanValues = value.filter((v) => !options.find((o) => o.value === v))

  const handleToggle = (val: string) => {
    const next = value.includes(val) ? value.filter((v) => v !== val) : [...value, val]
    onChange(next)
  }

  const handleAddOption = () => {
    if (!newOptionName.trim()) return
    const color = COLOR_NAMES[options.length % COLOR_NAMES.length]
    const option: SelectOption = { value: newOptionName.trim(), color }
    onAddOption?.(option)
    onChange([...value, option.value])
    setNewOptionName('')
    setIsCreating(false)
  }

  return (
    <Picker
      mode="multi"
      open={isOpen}
      onOpenChange={setIsOpen}
      value={value}
      onValueChange={handleToggle}
      closeOnSelect={false}
    >
      <Picker.Trigger variant="inline" asChild>
        <span>
          {selectedOptions.length > 0 || orphanValues.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {selectedOptions.map((opt) => (
                <SelectChip key={opt.value} value={opt.value} color={opt.color} />
              ))}
              {orphanValues.map((v) => (
                <SelectChip key={v} value={v} color="stone" />
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-text-tertiary font-sans">Empty</span>
          )}
        </span>
      </Picker.Trigger>
      <Picker.Content width={220} align="start">
        <Picker.Search placeholder="Search options..." />
        <Picker.List>
          {options.length === 0 && !isCreating && <Picker.Empty message="No options yet" />}
          {options.map((opt) => (
            <Picker.Item
              key={opt.value}
              value={opt.value}
              label={opt.value}
              indicator="checkbox"
              indicatorColor={getTagColors(opt.color).text}
              trailing={
                onRemoveOption ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onChange(value.filter((v) => v !== opt.value))
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
        </Picker.List>
        <Picker.Separator />
        {isCreating ? (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span
              className="size-2.5 rounded-full shrink-0"
              style={{
                backgroundColor: getTagColors(COLOR_NAMES[options.length % COLOR_NAMES.length]).text
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
                  handleAddOption()
                } else if (e.key === 'Escape') {
                  setIsCreating(false)
                  setNewOptionName('')
                }
              }}
              onBlur={() => {
                if (!newOptionName.trim()) setIsCreating(false)
              }}
              placeholder="Option name"
              className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        ) : (
          <Picker.Footer>
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent rounded-[5px]"
            >
              <Plus className="size-3.5" />
              New option
            </button>
          </Picker.Footer>
        )}
      </Picker.Content>
    </Picker>
  )
}
