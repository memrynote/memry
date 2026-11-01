/**
 * Templates Service
 *
 * The template commands of Step 13l (`commands/templates.rs`) in the shapes of Electron's
 * `templates:*` channels: a write answers `{ success, template }`, or `{ success: false, error }`
 * when the command throws.
 */

import {
  commands,
  events,
  type TemplateCreateInput as CreateArgs,
  type TemplateUpdateInput as UpdateArgs,
  type TemplateView
} from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

type TemplatePropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'
  | 'project'

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

function toTemplate(view: TemplateView): Template {
  return { ...view, description: view.description ?? undefined }
}

async function written(write: () => Promise<TemplateView>): Promise<TemplateCreateResponse> {
  try {
    return { success: true, template: toTemplate(await write()) }
  } catch (error) {
    return { success: false, template: null, error: extractErrorMessage(error, '') || undefined }
  }
}

/**
 * List all templates: the built-ins by name, then the vault's own by name.
 */
export async function listTemplates(): Promise<TemplateListResponse> {
  const templates = await commands.templatesList()
  return {
    templates: templates.map((item) => ({ ...item, description: item.description ?? undefined }))
  }
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<Template | null> {
  const view = await commands.templatesGet(id)
  return view ? toTemplate(view) : null
}

/**
 * Create a new template.
 */
export function createTemplate(input: TemplateCreateInput): Promise<TemplateCreateResponse> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a property value is the JSON the command carries as is
  return written(() => commands.templatesCreate(input as CreateArgs))
}

/**
 * Update an existing template.
 */
export function updateTemplate(input: TemplateUpdateInput): Promise<TemplateCreateResponse> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a property value is the JSON the command carries as is
  return written(() => commands.templatesUpdate(input as UpdateArgs))
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await commands.templatesDelete(id)
    return { success: true }
  } catch (error) {
    return { success: false, error: extractErrorMessage(error, '') || undefined }
  }
}

/**
 * Duplicate a template.
 */
export function duplicateTemplate(id: string, newName: string): Promise<TemplateCreateResponse> {
  return written(() => commands.templatesDuplicate(id, newName))
}

// Event listeners: each carries the template's id; the list refetches.
export function onTemplateCreated(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.templateCreatedEvent, callback)
}

export function onTemplateUpdated(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.templateUpdatedEvent, callback)
}

export function onTemplateDeleted(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.templateDeletedEvent, callback)
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
