/**
 * Templates Service
 *
 * Provides a typed wrapper around the templates API exposed via preload.
 */

// Types are defined in src/preload/index.d.ts and exposed via window.api
type TemplatePropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'

interface TemplateProperty {
  name: string
  type: TemplatePropertyType
  value: unknown
  options?: string[]
}

interface Template {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
  tags: string[]
  properties: TemplateProperty[]
  content: string
  createdAt: string
  modifiedAt: string
}

interface TemplateListItem {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}

interface TemplateCreateInput {
  name: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

interface TemplateUpdateInput {
  id: string
  name?: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

interface TemplateCreateResponse {
  success: boolean
  template: Template | null
  error?: string
}

interface TemplateListResponse {
  templates: TemplateListItem[]
}

export type {
  Template,
  TemplateListItem,
  TemplateCreateInput,
  TemplateUpdateInput,
  TemplateCreateResponse,
  TemplateListResponse,
  TemplateProperty
}

/**
 * List all templates.
 */
export async function listTemplates(): Promise<TemplateListResponse> {
  return window.api.templates.list()
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<Template | null> {
  return window.api.templates.get(id)
}

/**
 * Create a new template.
 */
export async function createTemplate(input: TemplateCreateInput): Promise<TemplateCreateResponse> {
  return window.api.templates.create(input)
}

/**
 * Update an existing template.
 */
export async function updateTemplate(input: TemplateUpdateInput): Promise<TemplateCreateResponse> {
  return window.api.templates.update(input)
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  return window.api.templates.delete(id)
}

/**
 * Duplicate a template.
 */
export async function duplicateTemplate(
  id: string,
  newName: string
): Promise<TemplateCreateResponse> {
  return window.api.templates.duplicate(id, newName)
}

// Event listeners
export function onTemplateCreated(callback: (event: { template: Template }) => void): () => void {
  return window.api.onTemplateCreated(callback)
}

export function onTemplateUpdated(
  callback: (event: { id: string; template: Template }) => void
): () => void {
  return window.api.onTemplateUpdated(callback)
}

export function onTemplateDeleted(callback: (event: { id: string }) => void): () => void {
  return window.api.onTemplateDeleted(callback)
}

// Default export
export const templatesService = {
  list: listTemplates,
  get: getTemplate,
  create: createTemplate,
  update: updateTemplate,
  delete: deleteTemplate,
  duplicate: duplicateTemplate
}

export default templatesService
