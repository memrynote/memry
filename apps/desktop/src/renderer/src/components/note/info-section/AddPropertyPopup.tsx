import { useCallback, useState } from 'react'
import { Picker } from '@/components/ui/picker'
import { type PropertyType, PROPERTY_TYPE_CONFIG, PROPERTY_TYPES, type NewProperty } from './types'

interface AddPropertyPopupProps {
  onAdd: (property: NewProperty) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  children: React.ReactNode
}

export function AddPropertyPopup({
  onAdd,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled = false,
  children
}: AddPropertyPopupProps): React.JSX.Element {
  const [propertyName, setPropertyName] = useState('')
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen

  const handleTypeSelect = useCallback(
    (type: string) => {
      const config = PROPERTY_TYPE_CONFIG[type as PropertyType]
      const baseName = propertyName.trim() || config.label
      onAdd({ name: baseName, type: type as PropertyType })
      setPropertyName('')
    },
    [onAdd, propertyName]
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next)
      controlledOnOpenChange?.(next)
      if (!next) setPropertyName('')
    },
    [controlledOpen, controlledOnOpenChange]
  )

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const list = e.currentTarget.closest('[data-slot="picker-content"]')
      const firstItem = list?.querySelector('[data-slot="picker-item"]') as HTMLButtonElement
      firstItem?.focus()
    }
  }, [])

  return (
    <Picker open={open} onOpenChange={handleOpenChange} onValueChange={handleTypeSelect}>
      <Picker.Trigger asChild disabled={disabled}>
        {children}
      </Picker.Trigger>
      <Picker.Content width={240} align="start">
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
          <div className="flex-1 flex items-center gap-1.5 rounded-[5px] bg-surface px-2 py-1 border border-border">
            <input
              type="text"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onClick={(e) => e.stopPropagation()}
              placeholder="Property name"
              className="flex-1 min-w-0 bg-transparent text-[13px] leading-4 text-foreground placeholder:text-muted-foreground/40 outline-none"
              aria-label="Property name"
            />
          </div>
        </div>
        <Picker.Section label="Type">
          <Picker.List>
            {PROPERTY_TYPES.map((propType) => {
              const config = PROPERTY_TYPE_CONFIG[propType]
              const IconComponent = config.icon
              return (
                <Picker.Item
                  key={propType}
                  value={propType}
                  label={config.label}
                  icon={
                    <span className="text-muted-foreground">
                      <IconComponent className="size-4" />
                    </span>
                  }
                />
              )
            })}
          </Picker.List>
        </Picker.Section>
      </Picker.Content>
    </Picker>
  )
}
