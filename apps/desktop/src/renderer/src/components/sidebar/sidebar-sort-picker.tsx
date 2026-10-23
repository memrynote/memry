import { ArrowDownAZ, ArrowUpAZ, ArrowUpDown, Clock, GripVertical, Plus } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import {
  SIDEBAR_SORT_MODES,
  type SidebarSortMode,
  type SidebarSortSurface
} from '@memry/contracts/sidebar-sort'

/**
 * The sort control every sidebar section shares.
 *
 * The mode list is per surface, not one global set: tags have a usage count but
 * no timestamps, and canvases have no stored manual order to return to. Showing
 * a mode a surface cannot honour would be a menu entry that does nothing.
 */
const MODE_ICONS: Record<SidebarSortMode, React.ReactNode> = {
  manual: <GripVertical className="h-3.5 w-3.5" />,
  'name-asc': <ArrowDownAZ className="h-3.5 w-3.5" />,
  'name-desc': <ArrowUpAZ className="h-3.5 w-3.5" />,
  'modified-desc': <Clock className="h-3.5 w-3.5" />,
  'modified-asc': <Clock className="h-3.5 w-3.5" />,
  'created-desc': <Plus className="h-3.5 w-3.5" />,
  'created-asc': <Plus className="h-3.5 w-3.5" />,
  // Matches what the tag list already showed for its two count modes.
  'count-desc': <ArrowUpDown className="h-3.5 w-3.5" />,
  'count-asc': <ArrowUpDown className="h-3.5 w-3.5" />
}

/**
 * A checkable view option listed under the sort modes. Only Collections has
 * any today (notes before folders, show files); every other surface passes
 * none and keeps the plain sort menu.
 */
export interface SidebarViewOptionToggle {
  /** Stable id; also the row's `data-testid` suffix. */
  id: string
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export interface SidebarSortPickerProps {
  surface: SidebarSortSurface
  mode: SidebarSortMode
  onModeChange: (mode: SidebarSortMode) => void
  /** Localized label per mode, keyed by mode id. */
  labels: Record<SidebarSortMode, string>
  /** Localized "Sort <section>: <current mode>" for the trigger. */
  triggerLabel: string
  viewOptions?: SidebarViewOptionToggle[]
  /** Accessible name for the view options group; required with `viewOptions`. */
  viewOptionsLabel?: string
}

export function SidebarSortPicker({
  surface,
  mode,
  onModeChange,
  labels,
  triggerLabel,
  viewOptions,
  viewOptionsLabel
}: SidebarSortPickerProps): React.JSX.Element {
  return (
    <Picker value={mode} onValueChange={(value) => onModeChange(value as SidebarSortMode)}>
      <Picker.Trigger
        variant="icon"
        className="h-5 w-5"
        aria-label={triggerLabel}
        // Stable hooks: the accessible name is localized, so tests and e2e
        // address the control by surface and read the mode off the element.
        data-testid={`sidebar-sort-${surface}`}
        data-sort-mode={mode}
      >
        <ArrowUpDown className="h-3 w-3" />
      </Picker.Trigger>
      <Picker.Content align="end" width={200}>
        <Picker.List>
          {SIDEBAR_SORT_MODES[surface].map((option) => (
            <Picker.Item
              key={option}
              value={option}
              label={labels[option]}
              icon={MODE_ICONS[option]}
              indicator="check"
            />
          ))}
        </Picker.List>
        {viewOptions && viewOptions.length > 0 && (
          <>
            <Picker.Separator />
            {/* Its own listbox: these rows are independent toggles, not more
                sort modes, so the group is multi-select. */}
            <Picker.List aria-label={viewOptionsLabel} aria-multiselectable>
              {viewOptions.map((option) => (
                <Picker.Item
                  key={option.id}
                  value={`view-option:${option.id}`}
                  label={option.label}
                  indicator="checkbox"
                  checked={option.checked}
                  data-testid={`sidebar-view-option-${option.id}`}
                  onClick={(e) => {
                    // A toggle, not a sort mode: keep the picker's value and
                    // leave the menu open so both options can be set at once.
                    e.preventDefault()
                    option.onCheckedChange(!option.checked)
                  }}
                />
              ))}
            </Picker.List>
          </>
        )}
      </Picker.Content>
    </Picker>
  )
}
