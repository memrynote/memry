/**
 * Object reads for tags with fields: search and "Linked here".
 *
 * @module ipc/tag-object-handlers
 */

import { ipcMain } from 'electron'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import {
  GetLinkedHereSchema,
  SearchObjectsSchema,
  type GetLinkedHereResponse,
  type SearchObjectsResponse
} from '@memry/contracts/tag-objects-api'
import { getIndexDatabase, requireDatabase } from '../database'
import { getLinkedHere, searchObjects } from '../tags/objects'
import { loadResolvedTags } from '../tags/schema/read'
import { createValidatedHandler } from './validate'

const CHANNELS = [TagsChannels.invoke.SEARCH_OBJECTS, TagsChannels.invoke.GET_LINKED_HERE]

export function registerTagObjectHandlers(): void {
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

export function unregisterTagObjectHandlers(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
}
