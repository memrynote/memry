/**
 * Display names for identifiers that originate in `@memry/contracts`.
 *
 * The contract identifiers themselves are part of the IPC surface and are
 * persisted in user data (`.folder.md` views, property definition JSON), so
 * they must never change. This module is the display layer that maps those
 * stable identifiers to translated strings, always falling back to the raw
 * identifier (or the caller's own fallback) when no mapping exists — so a
 * future contract value renders as itself rather than blank.
 *
 * @module lib/contract-display-names
 */

import { getI18n } from 'react-i18next'
import { DEFAULT_VIEW } from '@memry/contracts/folder-view-api'

/** Translate a `notes` namespace key, falling back to `fallback` when missing. */
function translate(key: string, fallback: string): string {
  const i18n = getI18n()
  if (!i18n) return fallback
  const value = i18n.getFixedT(null, 'notes')(key)
  return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback
}

// ============================================================================
// Built-in folder-view columns
// ============================================================================

/** Capitalize first letter and add spaces before capitals (for camelCase). */
export function formatColumnId(str: string): string {
  if (!str) return str
  const spaced = str.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Built-in column id → `notes` namespace key. Ids come from BUILT_IN_COLUMNS. */
const BUILT_IN_COLUMN_KEYS: Record<string, string> = {
  title: 'folderView.columns.title',
  folder: 'folderView.columns.folder',
  tags: 'folderView.columns.tags',
  created: 'folderView.columns.created',
  modified: 'folderView.columns.modified',
  wordCount: 'folderView.columns.wordCount',
  // Only tag views mix row kinds, so only they expose this column.
  kind: 'folderView.columns.kind'
}

/**
 * Display label for a folder-view column id.
 *
 * @param columnId - Column id from the view config (built-in id, property name, or `formula.x`)
 * @param fallback - Used when the id has no built-in mapping; defaults to the formatted id
 */
export function getColumnLabel(columnId: string, fallback?: string): string {
  const raw = fallback ?? formatColumnId(columnId)
  const key = BUILT_IN_COLUMN_KEYS[columnId]
  return key ? translate(key, raw) : raw
}

// ============================================================================
// Status property categories
// ============================================================================

/** Status category key → `notes` namespace key. Keys come from STATUS_CATEGORY_KEYS. */
const STATUS_CATEGORY_KEYS: Record<string, string> = {
  todo: 'properties.statusCategories.todo',
  in_progress: 'properties.statusCategories.inProgress',
  done: 'properties.statusCategories.done'
}

/**
 * Display label for a status category header.
 *
 * @param categoryKey - Stable category key from the property definition
 * @param fallback - The label stored on the category (English default from the contract)
 */
export function getStatusCategoryLabel(categoryKey: string, fallback: string): string {
  const key = STATUS_CATEGORY_KEYS[categoryKey]
  return key ? translate(key, fallback) : fallback
}

// ============================================================================
// Folder-view saved views
// ============================================================================

/**
 * Display name for a saved folder view. Only the contract-provided default
 * view name is translated; user-authored names render verbatim.
 */
export function getViewDisplayName(name: string): string {
  return name === DEFAULT_VIEW.name ? translate('folderView.defaultViewName', name) : name
}
