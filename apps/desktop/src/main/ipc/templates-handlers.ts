/**
 * Templates IPC handlers.
 * Handles all template-related IPC communication from renderer.
 *
 * @module ipc/templates-handlers
 */

import { ipcMain } from 'electron'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import {
  TemplateCreateSchema,
  TemplateUpdateSchema,
  TemplateDuplicateSchema
} from '@memry/contracts/templates-api'
import { createValidatedHandler, createStringHandler, createHandler, withErrorHandler } from './validate'
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
    createValidatedHandler(TemplateCreateSchema, withErrorHandler(async (input) => {
      const template = await createTemplate(input)
      return { success: true, template }
    }, 'Failed to create template'))
  )

  // templates:update - Update an existing template
  ipcMain.handle(
    TemplatesChannels.invoke.UPDATE,
    createValidatedHandler(TemplateUpdateSchema, withErrorHandler(async (input) => {
      const template = await updateTemplate(input)
      return { success: true, template }
    }, 'Failed to update template'))
  )

  // templates:delete - Delete a template
  ipcMain.handle(
    TemplatesChannels.invoke.DELETE,
    createStringHandler(withErrorHandler(async (id) => {
      await deleteTemplate(id)
      return { success: true }
    }, 'Failed to delete template'))
  )

  // templates:duplicate - Duplicate a template
  ipcMain.handle(
    TemplatesChannels.invoke.DUPLICATE,
    createValidatedHandler(TemplateDuplicateSchema, withErrorHandler(async (input) => {
      const template = await duplicateTemplate(input.id, input.newName)
      return { success: true, template }
    }, 'Failed to duplicate template'))
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
