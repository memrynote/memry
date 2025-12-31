/**
 * Folder View Components
 *
 * Obsidian Bases-like database view for folders.
 * Displays notes in a table format with sortable columns and filters.
 */

export { FolderTableView, type OrderConfig } from './folder-table-view'
export { ColumnHeader, type DragHandleProps } from './column-header'
export { SortableColumnHeader } from './sortable-column-header'
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
