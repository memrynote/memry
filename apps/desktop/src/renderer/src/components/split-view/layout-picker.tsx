/**
 * Layout Picker Component
 * Quick access to common layout presets
 */

import { Square, Columns2, Rows2, LayoutGrid, Grid2X2, PanelRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTabs } from '@/contexts/tabs'
import { layoutPresets, applyLayoutPreset, type LayoutPreset } from './layout-presets'
import { cn } from '@/lib/utils'

interface LayoutPickerProps {
  /** Additional CSS classes */
  className?: string
}

/**
 * Get icon for layout preset
 */
const getPresetIcon = (id: LayoutPreset): React.ReactNode => {
  switch (id) {
    case 'single':
      return <Square className="w-4 h-4" />
    case 'two-columns':
      return <Columns2 className="w-4 h-4" />
    case 'two-rows':
      return <Rows2 className="w-4 h-4" />
    case 'three-columns':
      return <LayoutGrid className="w-4 h-4" />
    case 'grid-2x2':
      return <Grid2X2 className="w-4 h-4" />
    case 'main-sidebar':
      return <PanelRight className="w-4 h-4" />
  }
}

/**
 * Layout picker with preset options
 */
export const LayoutPicker = ({ className }: LayoutPickerProps): React.JSX.Element => {
  const { state, dispatch } = useTabs()

  const handleSelectPreset = (preset: LayoutPreset): void => {
    const changes = applyLayoutPreset(state, preset)
    if (changes.tabGroups && changes.layout && changes.activeGroupId) {
      dispatch({
        type: 'SET_LAYOUT',
        payload: {
          tabGroups: changes.tabGroups,
          layout: changes.layout,
          activeGroupId: changes.activeGroupId
        }
      })
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-md',
            'text-gray-500 dark:text-gray-400',
            'hover:bg-gray-100 dark:hover:bg-gray-800',
            'transition-colors',
            className
          )}
          title="Layout presets"
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 px-1">Layout Presets</p>
        <div className="grid grid-cols-3 gap-1">
          {layoutPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleSelectPreset(preset.id)}
              className={cn(
                'flex flex-col items-center gap-1 p-2 rounded-md',
                'text-gray-600 dark:text-gray-300',
                'hover:bg-gray-100 dark:hover:bg-gray-800',
                'transition-colors'
              )}
              title={preset.description}
            >
              {getPresetIcon(preset.id)}
              <span className="text-[10px] leading-tight">{preset.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default LayoutPicker
