/**
 * Templates IPC handlers.
 * Handles all template-related IPC communication from renderer.
 *
 * @module ipc/templates-handlers
 */

import { ipcMain } from 'electron'
import { TemplatesChannels } from '@shared/ipc-channels'
import {
  TemplateCreateSchema,
  TemplateUpdateSchema,
  TemplateDuplicateSchema
} from '@shared/contracts/templates-api'
import { createValidatedHandler, createStringHandler, createHandler } from './validate'
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate
} from '../vault/templates'

/**
 * Register all template-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerTemplatesHandlers(): void {
  // templates:list - List all templates
  ipcMain.handle(
    TemplatesChannels.invoke.LIST,
    createHandler(async () => {
      const templates = await listTemplates()
      return { templates }
    })
  )

  // templates:get - Get a template by ID
  ipcMain.handle(
    TemplatesChannels.invoke.GET,
    createStringHandler(async (id) => {
      return getTemplate(id)
    })
  )

  // templates:create - Create a new template
  ipcMain.handle(
    TemplatesChannels.invoke.CREATE,
    createValidatedHandler(TemplateCreateSchema, async (input) => {
      try {
        const template = await createTemplate(input)
        return { success: true, template }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create template'
        return { success: false, template: null, error: message }
      }
    })
  )

  // templates:update - Update an existing template
  ipcMain.handle(
    TemplatesChannels.invoke.UPDATE,
    createValidatedHandler(TemplateUpdateSchema, async (input) => {
      try {
        const template = await updateTemplate(input)
        return { success: true, template }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update template'
        return { success: false, template: null, error: message }
      }
    })
  )

  // templates:delete - Delete a template
  ipcMain.handle(
    TemplatesChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      try {
        await deleteTemplate(id)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete template'
        return { success: false, error: message }
      }
    })
  )

  // templates:duplicate - Duplicate a template
  ipcMain.handle(
    TemplatesChannels.invoke.DUPLICATE,
    createValidatedHandler(TemplateDuplicateSchema, async (input) => {
      try {
        const template = await duplicateTemplate(input.id, input.newName)
        return { success: true, template }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to duplicate template'
        return { success: false, template: null, error: message }
      }
    })
  )
}

/**
 * Unregister all template-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterTemplatesHandlers(): void {
  Object.values(TemplatesChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
