import { useState } from 'react'
import { Plus, Trash2 } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { getTagColors } from '../../tags-row/tag-colors'
import { SelectChip } from './SelectChip'
import type { SelectOption } from '@memry/contracts/property-types'
import { COLOR_NAMES } from '../../tags-row/tag-colors'

interface SelectEditorProps {
  value: string | null
  options: SelectOption[]
  defaultOpen?: boolean
  onChange: (value: string | null) => void
  onAddOption?: (option: SelectOption) => void
  onRemoveOption?: (optionValue: string) => void
}

export function SelectEditor({
  value,
  options,
  defaultOpen,
  onChange,
  onAddOption,
  onRemoveOption
}: SelectEditorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false)
  const [newOptionName, setNewOptionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const selectedOption = options.find((o) => o.value === value)
  const isOrphan = value && !selectedOption

  const handleAddOption = () => {
    if (!newOptionName.trim()) return
    const color = COLOR_NAMES[options.length % COLOR_NAMES.length]
    const option: SelectOption = { value: newOptionName.trim(), color }
    onAddOption?.(option)
    onChange(option.value)
    setNewOptionName('')
    setIsCreating(false)
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
        <Picker.Search placeholder="Search options..." />
        <Picker.List>
          {options.length === 0 && !isCreating && <Picker.Empty message="No options yet" />}
          {options.map((opt) => (
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
                    className="p-0.5 rounded text-muted-foreground/30 hover:text-destructive opacity-0 group-hover/option:opacity-100"
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
