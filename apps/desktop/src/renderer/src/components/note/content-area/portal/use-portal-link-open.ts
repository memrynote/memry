/**
 * Opening a `[[link]]` clicked inside a portal window. The window is a nested
 * editor with no page around it, so it opens the target as a tab the way the
 * host note's own links do.
 *
 * @module note/content-area/portal/use-portal-link-open
 */

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { createLogger } from '@/lib/logger'
import type { WikiLinkOpenTarget } from '../types'

const log = createLogger('PortalLinkOpen')

export function usePortalLinkOpen(): (target: string, open?: WikiLinkOpenTarget) => void {
  const { t } = useT('common')
  const { openSidebarItem } = useSidebarNavigation()

  return useCallback(
    (target, open) => {
      void (async () => {
        try {
          const resolved = await resolveWikiLink(target)
          if (resolved.type !== 'note' && resolved.type !== 'file') return
          openSidebarItem(
            {
              type: resolved.type,
              path: resolved.type === 'note' ? `/notes/${resolved.id}` : `/file/${resolved.id}`,
              entityId: resolved.id,
              title: resolved.title
            },
            {
              inNewTab: open === 'newTab' || open === 'backgroundTab',
              inBackground: open === 'backgroundTab',
              toTheSide: open === 'side'
            }
          )
        } catch (err) {
          log.error('Failed to open a link from a portal', err)
          toast.error(t('portalBlock.actionFailed'))
        }
      })()
    },
    [openSidebarItem, t]
  )
}
