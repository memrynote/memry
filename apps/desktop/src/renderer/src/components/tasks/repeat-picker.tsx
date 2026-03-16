import { useState, useMemo, useCallback } from 'react'
import { RefreshCw, ChevronDown, Check } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { getRepeatPresets, getRepeatDisplayText, type RepeatPreset } from '@/lib/repeat-utils'
import type { RepeatConfig } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface RepeatPickerProps {
  value: RepeatConfig | null
  dueDate: Date | null
  onChange: (config: RepeatConfig | null) => void
  onOpenCustomDialog?: () => void
  disabled?: boolean
  className?: string
}

// ============================================================================
// REPEAT PICKER COMPONENT
// ============================================================================

export const RepeatPicker = ({
  value,
  dueDate,
  onChange,
  onOpenCustomDialog,
  disabled = false,
  className
}: RepeatPickerProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  // Generate presets based on due date
  const presets = useMemo(() => getRepeatPresets(dueDate), [dueDate])

  // Get current display text
  const displayText = useMemo(() => {
    if (!value) return 'Does not repeat'
    return getRepeatDisplayText(value)
  }, [value])

  // Check if current value matches a preset
  const matchingPresetId = useMemo(() => {
    if (!value) return null

    // Simple matching based on display text
    const currentText = getRepeatDisplayText(value)
    const matchingPreset = presets.find((p) => getRepeatDisplayText(p.config) === currentText)
    return matchingPreset?.id || null
  }, [value, presets])

  const handleSelectPreset = useCallback(
    (preset: RepeatPreset | null): void => {
      if (!preset) {
        onChange(null)
      } else {
        onChange(preset.config)
      }
      setIsOpen(false)
    },
    [onChange]
  )

  const handleOpenCustom = useCallback((): void => {
    setIsOpen(false)
    onOpenCustomDialog?.()
  }, [onOpenCustomDialog])

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={isOpen}
          aria-label="Select repeat frequency"
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className
          )}
        >
          <div className="flex items-center gap-2 truncate">
            <RefreshCw
              className={cn(
                'size-4 shrink-0',
                value ? 'text-task-repeat' : 'text-muted-foreground'
              )}
              aria-hidden="true"
            />
            <span className="truncate">{displayText}</span>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[280px] p-1" align="start">
        {/* Does not repeat option */}
        <button
          type="button"
          onClick={() => handleSelectPreset(null)}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
            'hover:bg-accent focus:bg-accent focus:outline-none',
            !value && 'bg-accent/50'
          )}
        >
          <span className="size-4 flex items-center justify-center">
            {!value && <Check className="size-4" aria-hidden="true" />}
          </span>
          <span>Does not repeat</span>
        </button>

        <Separator className="my-1" />

        {/* Preset options */}
        <div className="flex flex-col">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleSelectPreset(preset)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                'hover:bg-accent focus:bg-accent focus:outline-none',
                matchingPresetId === preset.id && 'bg-accent/50'
              )}
            >
              <span className="size-4 flex items-center justify-center">
                {matchingPresetId === preset.id && <Check className="size-4" aria-hidden="true" />}
              </span>
              <span>{preset.label}</span>
            </button>
          ))}
        </div>

        {/* Custom option */}
        {onOpenCustomDialog && (
          <>
            <Separator className="my-1" />
            <button
              type="button"
              onClick={handleOpenCustom}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                'hover:bg-accent focus:bg-accent focus:outline-none text-muted-foreground'
              )}
            >
              <span className="size-4" />
              <span>Custom...</span>
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default RepeatPicker
