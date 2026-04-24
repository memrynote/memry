/**
 * Templates Service
 *
 * Provides a typed wrapper around the templates API via Tauri invoke.
 */

import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

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
  return invoke<TemplateListResponse>('templates_list')
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<Template | null> {
  return invoke<Template | null>('templates_get', { args: [id] })
}

/**
 * Create a new template.
 */
export async function createTemplate(input: TemplateCreateInput): Promise<TemplateCreateResponse> {
  return invoke<TemplateCreateResponse>(
    'templates_create',
    input as unknown as Record<string, unknown>
  )
}

/**
 * Update an existing template.
 */
export async function updateTemplate(input: TemplateUpdateInput): Promise<TemplateCreateResponse> {
  return invoke<TemplateCreateResponse>(
    'templates_update',
    input as unknown as Record<string, unknown>
  )
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  return invoke<{ success: boolean; error?: string }>('templates_delete', { args: [id] })
}

/**
 * Duplicate a template.
 */
export async function duplicateTemplate(
  id: string,
  newName: string
): Promise<TemplateCreateResponse> {
  return invoke<TemplateCreateResponse>('templates_duplicate', { args: [id, newName] })
}

// Event listeners
export function onTemplateCreated(callback: (event: { template: Template }) => void): () => void {
  return subscribeEvent<{ template: Template }>('template-created', callback)
}

export function onTemplateUpdated(
  callback: (event: { id: string; template: Template }) => void
): () => void {
  return subscribeEvent<{ id: string; template: Template }>('template-updated', callback)
}

export function onTemplateDeleted(callback: (event: { id: string }) => void): () => void {
  return subscribeEvent<{ id: string }>('template-deleted', callback)
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
