/**
 * The `/` menu rows for portals. Ids are stable (`portal`, `search_portal`):
 * recents are stored by them.
 *
 * @module note/content-area/portal-flows/portal-slash-items
 */

import { SuggestionMenu } from '@blocknote/core/extensions'
import type { EditorSchema } from '../editor-schema'
import { getPortalFlowsApi } from './portal-flows-api'

/** The trigger that opens the picker, typed or by the `/portal` row. */
export const PORTAL_PICKER_TRIGGER = '(('

export interface PortalSlashLabels {
  portal: { title: string; subtext: string }
  searchPortal: { title: string; subtext: string }
}

export function getPortalSlashMenuItems(
  editor: EditorSchema['BlockNoteEditor'],
  labels: PortalSlashLabels,
  group: string
) {
  return [
    {
      id: 'portal',
      title: labels.portal.title,
      // Opened through the suggestion plugin's own opener: inserting the
      // trigger text any other way leaves the plugin with no state and no menu.
      onItemClick: () =>
        editor
          .getExtension(SuggestionMenu)
          ?.openSuggestionMenu(PORTAL_PICKER_TRIGGER, { deleteTriggerCharacter: true }),
      aliases: ['portal', 'transclude', 'embed note', 'embed block', 'live block', 'mirror'],
      group,
      subtext: labels.portal.subtext
    },
    {
      id: 'search_portal',
      title: labels.searchPortal.title,
      onItemClick: () => getPortalFlowsApi(editor)?.openSearchCreate(),
      aliases: ['search', 'query', 'portal search', 'live search', 'saved search'],
      group,
      subtext: labels.searchPortal.subtext
    }
  ]
}
