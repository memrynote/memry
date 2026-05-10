import { useState, useMemo, useCallback, useId } from 'react'
import { Popover } from '@/components/ui/popover'
import { PickerContext, type PickerMode } from './types'

interface PickerRootProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  mode?: PickerMode
  closeOnSelect?: boolean
  value?: string | string[] | null
  onValueChange?: (value: string) => void
  children: React.ReactNode
}

export function PickerRoot({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  mode = 'single',
  closeOnSelect,
  value = null,
  onValueChange,
  children
}: PickerRootProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const [searchQuery, setSearchQuery] = useState('')
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const contentId = useId()

  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next)
      controlledOnOpenChange?.(next)
      if (!next) {
        setSearchQuery('')
        setActivePanel(null)
      }
    },
    [isControlled, controlledOnOpenChange]
  )

  const shouldClose = closeOnSelect ?? mode === 'single'

  const handleValueChange = useCallback(
    (val: string) => {
      onValueChange?.(val)
      if (shouldClose) handleOpenChange(false)
    },
    [onValueChange, shouldClose, handleOpenChange]
  )

  const ctx = useMemo(
    () => ({
      open,
      contentId,
      onOpenChange: handleOpenChange,
      mode,
      value,
      onValueChange: handleValueChange,
      searchQuery,
      onSearchChange: setSearchQuery,
      activePanel,
      onPanelChange: setActivePanel
    }),
    [open, contentId, handleOpenChange, mode, value, handleValueChange, searchQuery, activePanel]
  )

  return (
    <PickerContext.Provider value={ctx}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        {children}
      </Popover>
    </PickerContext.Provider>
  )
}
