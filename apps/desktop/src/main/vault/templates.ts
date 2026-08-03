/**
 * Template CRUD operations.
 *
 * Custom templates are rows in the data DB `templates` table and sync across
 * devices with whole-row LWW. Built-in templates are code constants (see
 * ./built-in-templates) — they have fixed ids, are identical on every device
 * and immutable, so they are never stored and never synced.
 *
 * Legacy installs kept custom templates as markdown files in
 * vault/.memry/templates/. They are imported once on vault open (see
 * ./templates-migration) and the files are left on disk as a downgrade path.
 *
 * @module vault/templates
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { templates as templatesTable, type TemplateRow } from '@memry/db-schema/schema/templates'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import type {
  Template,
  TemplateListItem,
  TemplateCreateInput,
  TemplateUpdateInput,
  TemplateProperty
} from '@memry/contracts/templates-api'
import { BUILT_IN_TEMPLATES } from './built-in-templates'
import { getDatabase } from '../database'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { createLogger } from '../lib/logger'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete
} from '../sync/local-mutations'

const logger = createLogger('Templates')

/**
 * Built-ins are immutable, so a stable timestamp keeps them from looking
 * "modified" every launch.
 */
const BUILT_IN_TIMESTAMP = '2025-01-01T00:00:00.000Z'

// ============================================================================
// Built-in Templates
// ============================================================================

export { BUILT_IN_TEMPLATES }

const BUILT_IN_IDS = new Set(BUILT_IN_TEMPLATES.map((t) => t.id))

// ============================================================================
// Helpers
// ============================================================================

/**
 * Emit template event to all windows.
 */
function emitTemplateEvent(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

function toBuiltInTemplate(template: Omit<Template, 'createdAt' | 'modifiedAt'>): Template {
  return {
    ...template,
    createdAt: BUILT_IN_TIMESTAMP,
    modifiedAt: BUILT_IN_TIMESTAMP
  }
}

function rowToTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? null,
    isBuiltIn: false,
    tags: row.tags ?? [],
    properties: (row.properties ?? []) as TemplateProperty[],
    content: row.content,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function getRow(id: string): TemplateRow | undefined {
  return getDatabase().select().from(templatesTable).where(eq(templatesTable.id, id)).get()
}

function assertNotBuiltIn(id: string, action: 'modify' | 'delete'): void {
  if (BUILT_IN_IDS.has(id)) {
    throw new VaultError(`Cannot ${action} built-in templates`, VaultErrorCode.PERMISSION_DENIED)
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * List all templates: built-ins from code, custom ones from the DB.
 */
export async function listTemplates(): Promise<TemplateListItem[]> {
  const items: TemplateListItem[] = BUILT_IN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    isBuiltIn: true
  }))

  try {
    for (const row of getDatabase().select().from(templatesTable).all()) {
      items.push({
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        icon: row.icon,
        isBuiltIn: false
      })
    }
  } catch (error) {
    logger.error('Failed to list custom templates:', error)
  }

  // Sort: built-in first, then by name
  items.sort((a, b) => {
    if (a.isBuiltIn !== b.isBuiltIn) {
      return a.isBuiltIn ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return items
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<Template | null> {
  const builtIn = BUILT_IN_TEMPLATES.find((t) => t.id === id)
  if (builtIn) return toBuiltInTemplate(builtIn)

  const row = getRow(id)
  return row ? rowToTemplate(row) : null
}

/**
 * Create a new custom template.
 */
export async function createTemplate(input: TemplateCreateInput): Promise<Template> {
  const id = generateNoteId()
  const now = new Date().toISOString()

  const template: Template = {
    id,
    name: input.name,
    description: input.description,
    icon: input.icon ?? null,
    isBuiltIn: false,
    tags: input.tags ?? [],
    properties: (input.properties ?? []) as TemplateProperty[],
    content: input.content ?? '',
    createdAt: now,
    modifiedAt: now
  }

  getDatabase()
    .insert(templatesTable)
    .values({
      id,
      name: template.name,
      description: template.description ?? null,
      icon: template.icon,
      tags: template.tags,
      properties: template.properties,
      content: template.content,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  // Registry wiring alone does nothing — a mutation that skips this enqueue
  // writes the row, seeds once via seedUnclocked, then never syncs again.
  enqueueLocalSyncCreate('template', id)

  emitTemplateEvent(TemplatesChannels.events.CREATED, { template })

  return template
}

/**
 * Update an existing custom template.
 */
export async function updateTemplate(input: TemplateUpdateInput): Promise<Template> {
  assertNotBuiltIn(input.id, 'modify')

  const row = getRow(input.id)
  if (!row) {
    throw new VaultError(`Template not found: ${input.id}`, VaultErrorCode.NOT_FOUND)
  }

  const existing = rowToTemplate(row)
  const now = new Date().toISOString()

  const updated: Template = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    icon: input.icon !== undefined ? input.icon : existing.icon,
    tags: input.tags ?? existing.tags,
    properties:
      input.properties !== undefined
        ? (input.properties as TemplateProperty[])
        : existing.properties,
    content: input.content ?? existing.content,
    modifiedAt: now
  }

  getDatabase()
    .update(templatesTable)
    .set({
      name: updated.name,
      description: updated.description ?? null,
      icon: updated.icon,
      tags: updated.tags,
      properties: updated.properties,
      content: updated.content,
      modifiedAt: now
    })
    .where(eq(templatesTable.id, input.id))
    .run()

  enqueueLocalSyncUpdate('template', input.id)

  emitTemplateEvent(TemplatesChannels.events.UPDATED, { id: input.id, template: updated })

  return updated
}

/**
 * Delete a custom template.
 */
export async function deleteTemplate(id: string): Promise<void> {
  assertNotBuiltIn(id, 'delete')

  const row = getRow(id)
  if (!row) {
    throw new VaultError(`Template not found: ${id}`, VaultErrorCode.NOT_FOUND)
  }

  // Snapshot before the delete: enqueueDelete returns early without a payload
  // and the tombstone would never reach the other devices.
  const snapshot = JSON.stringify(row)

  getDatabase().delete(templatesTable).where(eq(templatesTable.id, id)).run()

  enqueueLocalSyncDelete('template', id, snapshot)

  emitTemplateEvent(TemplatesChannels.events.DELETED, { id })
}

/**
 * Duplicate a template. Duplicating a built-in produces a custom template.
 */
export async function duplicateTemplate(id: string, newName: string): Promise<Template> {
  const existing = await getTemplate(id)
  if (!existing) {
    throw new VaultError(`Template not found: ${id}`, VaultErrorCode.NOT_FOUND)
  }

  return createTemplate({
    name: newName,
    description: existing.description,
    icon: existing.icon,
    tags: [...existing.tags],
    properties: existing.properties.map((p) => ({ ...p })),
    content: existing.content
  })
}

/**
 * Apply a template to create note content.
 * Replaces {{title}} placeholder with actual title.
 */
export function applyTemplate(
  template: Template,
  title: string
): {
  content: string
  tags: string[]
  properties: Record<string, unknown>
} {
  // Replace {{title}} placeholder
  const content = template.content.replace(/\{\{title\}\}/g, title)

  // Convert properties array to record
  const properties: Record<string, unknown> = {}
  for (const prop of template.properties) {
    properties[prop.name] = prop.value
  }

  return {
    content,
    tags: [...template.tags],
    properties
  }
}
