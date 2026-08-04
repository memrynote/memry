import { useCallback, useState } from 'react'
import { Picker } from '@/components/ui/picker'
import { type PropertyType, PROPERTY_TYPE_CONFIG, PROPERTY_TYPES, type NewProperty } from './types'
import { useT } from '@memry/i18n/renderer'

interface AddPropertyPopupProps {
  onAdd: (property: NewProperty) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  /** Types this surface cannot store, and so must not offer. */
  excludeTypes?: PropertyType[]
  children: React.ReactNode
}

export function AddPropertyPopup({
  onAdd,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled = false,
  excludeTypes,
  children
}: AddPropertyPopupProps): React.JSX.Element {
  const { t } = useT('notes')
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

  const offeredTypes = excludeTypes?.length
    ? PROPERTY_TYPES.filter((type) => !excludeTypes.includes(type))
    : PROPERTY_TYPES

  const propertyTypeLabels: Record<PropertyType, string> = {
    text: t('properties.types.text'),
    number: t('properties.types.number'),
    date: t('properties.types.date'),
    checkbox: t('properties.types.checkbox'),
    url: t('properties.types.url'),
    status: t('properties.types.status'),
    select: t('properties.types.select'),
    multiselect: t('properties.types.multiselect'),
    relation: t('properties.types.relation')
  }

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
              placeholder={t('properties.namePlaceholder')}
              className="flex-1 min-w-0 bg-transparent text-[13px] leading-4 text-foreground placeholder:text-muted-foreground/40 outline-none"
              aria-label={t('properties.nameAria')}
            />
          </div>
        </div>
        <Picker.Section label={t('properties.typeSection')}>
          <Picker.List>
            {offeredTypes.map((propType) => {
              const config = PROPERTY_TYPE_CONFIG[propType]
              const IconComponent = config.icon
              return (
                <Picker.Item
                  key={propType}
                  value={propType}
                  label={propertyTypeLabels[propType]}
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
