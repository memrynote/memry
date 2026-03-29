import { PickerRoot } from './picker-root'
import { PickerTrigger } from './picker-trigger'
import { PickerContent } from './picker-content'
import { PickerSearch } from './picker-search'
import { PickerList } from './picker-list'
import { PickerItem } from './picker-item'
import { PickerSection } from './picker-section'
import { PickerSeparator } from './picker-separator'
import { PickerFooter } from './picker-footer'
import { PickerEmpty } from './picker-empty'
import { PickerPanel } from './picker-panel'

export const Picker = Object.assign(PickerRoot, {
  Trigger: PickerTrigger,
  Content: PickerContent,
  Search: PickerSearch,
  List: PickerList,
  Item: PickerItem,
  Section: PickerSection,
  Separator: PickerSeparator,
  Footer: PickerFooter,
  Empty: PickerEmpty,
  Panel: PickerPanel
})

export { usePickerSearch } from './use-picker-search'
export { usePickerContext } from './types'
export type { PickerMode, PickerIndicator } from './types'
