/**
 * Object reads for tags with fields: search and "Linked here".
 *
 * @module ipc/tag-object-handlers
 */

import { ipcMain } from 'electron'
import { TagSchemaChannels, TagsChannels } from '@memry/contracts/ipc-channels'
import {
  FillFieldsSchema,
  type FieldFillStatus,
  type FillFieldsResult
} from '@memry/contracts/tag-fill-api'
import {
  GetLinkedHereSchema,
  SearchObjectsSchema,
  type GetLinkedHereResponse,
  type SearchObjectsResponse
} from '@memry/contracts/tag-objects-api'
import type * as FillFields from '../ai-inline/fill-fields'
import { fieldFillStatus } from '../ai-inline/fill-fields-status'
import { getIndexDatabase, requireDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { store } from '../store'
import { getNoteById } from '../vault/notes-crud'
import { readAIInlineSettings } from './ai-inline-handlers'
import { getLinkedHere, searchObjects } from '../tags/objects'
import { loadResolvedTags } from '../tags/schema/read'
import { createValidatedHandler } from './validate'

const logger = createLogger('IPC:TagObjects')

const CHANNELS = [
  TagsChannels.invoke.SEARCH_OBJECTS,
  TagsChannels.invoke.GET_LINKED_HERE,
  TagSchemaChannels.invoke.FILL_STATUS,
  TagSchemaChannels.invoke.FILL_FIELDS
]

let fillFieldsLoad: Promise<typeof FillFields> | null = null

// Lazy for the same reason as writing assist: `ai` and the provider SDKs stay
// out of the main process until the user asks the model. See
// scripts/check-main-startup-set.mjs.
function loadFillFields(): Promise<typeof FillFields> {
  if (!fillFieldsLoad) {
    fillFieldsLoad = import('../ai-inline/fill-fields').catch((error: unknown) => {
      fillFieldsLoad = null
      throw error
    })
  }
  return fillFieldsLoad
}

function fillDisclosureAccepted(): boolean {
  return store.get('agent').fieldFillDisclosureAccepted === true
}

export function registerTagObjectHandlers(): void {
  registerTagFillHandlers()

  ipcMain.handle(
    TagsChannels.invoke.SEARCH_OBJECTS,
    createValidatedHandler(SearchObjectsSchema, (input): SearchObjectsResponse => {
      const dataDb = requireDatabase()
      return searchObjects(getIndexDatabase(), loadResolvedTags(dataDb), input)
    })
  )

  ipcMain.handle(
    TagsChannels.invoke.GET_LINKED_HERE,
    createValidatedHandler(GetLinkedHereSchema, (input): GetLinkedHereResponse => {
      const dataDb = requireDatabase()
      return {
        groups: getLinkedHere(getIndexDatabase(), dataDb, loadResolvedTags(dataDb), input)
      }
    })
  )
}

function registerTagFillHandlers(): void {
  ipcMain.handle(TagSchemaChannels.invoke.FILL_STATUS, (): FieldFillStatus =>
    fieldFillStatus(readAIInlineSettings(), fillDisclosureAccepted())
  )

  ipcMain.handle(
    TagSchemaChannels.invoke.FILL_FIELDS,
    createValidatedHandler(FillFieldsSchema, async (input): Promise<FillFieldsResult> => {
      const dataDb = requireDatabase()
      const indexDb = getIndexDatabase()
      const resolved = loadResolvedTags(dataDb)
      const { fillFields } = await loadFillFields()
      try {
        return await fillFields(
          {
            settings: readAIInlineSettings(),
            disclosureAccepted: fillDisclosureAccepted(),
            acceptDisclosure: () =>
              store.set('agent', { ...store.get('agent'), fieldFillDisclosureAccepted: true }),
            getNote: async (noteId) => {
              const note = await getNoteById(noteId)
              if (!note || note.contentOmitted) return null
              return {
                title: note.title,
                content: note.content,
                headerTags: note.headerTags,
                properties: note.properties ?? {}
              }
            },
            resolved,
            locale: getMainI18n().language,
            searchObjects: (tag) =>
              searchObjects(indexDb, resolved, { query: '', tag, limit: 50 }).matches
          },
          input
        )
      } catch (error) {
        logger.warn('Field fill failed', { error })
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}

export function unregisterTagObjectHandlers(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
}
