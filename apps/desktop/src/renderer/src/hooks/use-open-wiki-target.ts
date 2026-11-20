/**
 * Opening a `[[link]]` clicked outside a note page: inside a portal window (a
 * nested editor with no page around it) or in a task title. It opens the target
 * as a tab the way a note's own links do.
 *
 * @module hooks/use-open-wiki-target
 */

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { journalDayTab } from '@/lib/memry-links'
import { createLogger } from '@/lib/logger'
import type { WikiLinkOpenTarget } from '@/components/note/content-area/types'

const log = createLogger('OpenWikiTarget')

export function useOpenWikiTarget(): (target: string, open?: WikiLinkOpenTarget) => void {
  const { t } = useT('common')
  const { openSidebarItem } = useSidebarNavigation()

  return useCallback(
    (target, open) => {
      void (async () => {
        try {
          const resolved = await resolveWikiLink(target)
          const options = {
            inNewTab: open === 'newTab' || open === 'backgroundTab',
            inBackground: open === 'backgroundTab',
            toTheSide: open === 'side'
          }
          if (resolved.type === 'journal') {
            const { type, path, entityId, title, viewState } = journalDayTab(
              resolved.id,
              resolved.heading
            )
            openSidebarItem({ type, path, entityId, title, viewState }, options)
            return
          }
          if (resolved.type !== 'note' && resolved.type !== 'file') return
          openSidebarItem(
            {
              type: resolved.type,
              path: resolved.type === 'note' ? `/notes/${resolved.id}` : `/file/${resolved.id}`,
              entityId: resolved.id,
              title: resolved.title
            },
            options
          )
        } catch (err) {
          log.error('Failed to open a wiki link', err)
          toast.error(t('wikiLink.openFailed'))
        }
      })()
    },
    [openSidebarItem, t]
  )
}
