import { useState, useMemo, useCallback } from 'react'
import { RefreshCw, ChevronDown, Check } from '@/lib/icons'

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getRepeatPresets, getRepeatDisplayText, type RepeatPreset } from '@/lib/repeat-utils'
import type { RepeatConfig } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  const { t } = useT('common')
  const [isOpen, setIsOpen] = useState(false)

  // Generate presets based on due date
  const presets = useMemo(() => getRepeatPresets(dueDate), [dueDate])

  // Get current display text
  const displayText = useMemo(() => {
    if (!value) return 'Does not repeat'
    return getRepeatDisplayText(value, t)
  }, [value, t])

  // Check if current value matches a preset
  const matchingPresetId = useMemo(() => {
    if (!value) return null

    // Simple matching based on display text
    const currentText = getRepeatDisplayText(value, t)
    const matchingPreset = presets.find((p) => getRepeatDisplayText(p.config, t) === currentText)
    return matchingPreset?.id || null
  }, [value, presets, t])

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
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={tPhaseF('phaseF.componentsTasksRepeatPicker.selectRepeatFrequency')}
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
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-[280px]" align="start">
        {/* Does not repeat option */}
        <DropdownMenuItem
          onSelect={() => handleSelectPreset(null)}
          className={cn(!value && 'bg-accent/50')}
        >
          <span className="flex size-4 items-center justify-center">
            {!value && <Check className="size-4" aria-hidden="true" />}
          </span>
          <span>{tPhaseF('phaseF.componentsTasksRepeatPicker.doesNotRepeat')}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Preset options */}
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onSelect={() => handleSelectPreset(preset)}
            className={cn(matchingPresetId === preset.id && 'bg-accent/50')}
          >
            <span className="flex size-4 items-center justify-center">
              {matchingPresetId === preset.id && <Check className="size-4" aria-hidden="true" />}
            </span>
            <span>{preset.label}</span>
          </DropdownMenuItem>
        ))}

        {/* Custom option */}
        {onOpenCustomDialog && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleOpenCustom}>
              <span className="size-4" />
              <span>{tPhaseF('phaseF.componentsTasksRepeatPicker.custom')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default RepeatPicker
