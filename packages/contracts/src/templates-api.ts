/**
 * Templates API Contract
 *
 * Defines types and schemas for note templates.
 * Templates are stored as markdown files in vault/.memry/templates/
 */

import { z } from 'zod'
import type { ViewConfig, PropertyDisplay, SummaryConfig } from './folder-view-api'

// ============================================================================
// Types
// ============================================================================

/**
 * Property type for template properties
 */
export type TemplatePropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'

/**
 * A property definition within a template
 */
export interface TemplateProperty {
  name: string
  type: TemplatePropertyType
  value: unknown
  options?: string[] // For select/multiselect types
}

/**
 * Full template object
 */
export interface Template {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
  tags: string[]
  properties: TemplateProperty[]
  content: string // Markdown body (without frontmatter)
  createdAt: string
  modifiedAt: string
}

/**
 * Template list item (summary for listings)
 */
export interface TemplateListItem {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}

/**
 * Folder configuration for default templates and view settings.
 * Stored in .folder.md files in each folder.
 */
export interface FolderConfig {
  /** Default template ID for new notes in this folder */
  template?: string
  /** Whether to inherit template from parent folder (default: true) */
  inherit?: boolean

  // View configuration (Folder View / Bases feature)
  /** Named views for this folder (table, grid, etc.) */
  views?: ViewConfig[]
  /** Computed column formulas */
  formulas?: Record<string, string>
  /** Property display overrides */
  properties?: Record<string, PropertyDisplay>
  /** Column summary configurations */
  summaries?: Record<string, SummaryConfig>
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const TemplatePropertySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url', 'rating']),
  value: z.unknown(),
  options: z.array(z.string()).optional()
})

export const TemplateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  properties: z.array(TemplatePropertySchema).optional().default([]),
  content: z.string().default('')
})

export const TemplateUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  properties: z.array(TemplatePropertySchema).optional(),
  content: z.string().optional()
})

export const TemplateDuplicateSchema = z.object({
  id: z.string().min(1),
  newName: z.string().min(1).max(200)
})

export const FolderConfigSchema = z.object({
  template: z.string().optional(),
  inherit: z.boolean().optional().default(true)
})

export const SetFolderConfigSchema = z.object({
  folderPath: z.string(),
  config: FolderConfigSchema
})

// ============================================================================
// Input Types (derived from schemas)
// ============================================================================

export type TemplateCreateInput = z.infer<typeof TemplateCreateSchema>
export type TemplateUpdateInput = z.infer<typeof TemplateUpdateSchema>
export type TemplateDuplicateInput = z.infer<typeof TemplateDuplicateSchema>

// ============================================================================
// Response Types
// ============================================================================

export interface TemplateCreateResponse {
  success: boolean
  template: Template | null
  error?: string
}

export interface TemplateListResponse {
  templates: TemplateListItem[]
}

export interface TemplateDeleteResponse {
  success: boolean
  error?: string
}
