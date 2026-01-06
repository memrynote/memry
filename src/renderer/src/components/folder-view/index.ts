/**
 * Folder View Components
 *
 * Obsidian Bases-like database view for folders.
 * Displays notes in a table format with sortable columns and filters.
 */

export { FolderTableView, type OrderConfig } from './folder-table-view'
export { FolderViewToolbar } from './folder-view-toolbar'
export { ViewSwitcher } from './view-switcher'
export { ColumnHeader, type DragHandleProps } from './column-header'
export { ColumnSelector } from './column-selector'
export { SortableColumnHeader } from './sortable-column-header'
export { FilterBuilder } from './filter-builder'
export { FilterRow, type FilterCondition, type PropertyInfo } from './filter-row'
export {
  PropertyCell,
  TextCell,
  NumberCell,
  CheckboxCell,
  DateCell,
  SelectCell,
  MultiSelectCell,
  UrlCell,
  RatingCell,
  TitleCell,
  FolderCell,
  TagsCell,
  WordCountCell,
  type PropertyType
} from './property-cell'
export { RowContextMenu } from './row-context-menu'
export { SummaryRow } from './summary-row'
