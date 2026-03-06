/**
 * Canonical persisted note property types shared across contracts and schema.
 *
 * This intentionally stays limited to the property types currently stored in
 * the note cache and exposed by the notes/properties APIs. Folder-view and
 * template-specific view types remain separate until that broader canon is
 * resolved.
 */

export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  URL: 'url'
} as const

export type PropertyType = (typeof PropertyTypes)[keyof typeof PropertyTypes]
