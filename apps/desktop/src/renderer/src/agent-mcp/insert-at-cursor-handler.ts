import { useEffect } from 'react'

import {
  AgentMcpInsertAtCursorChannel,
  AgentMcpInsertAtCursorRequestSchema,
  type AgentMcpInsertAtCursorRequest,
  type AgentMcpInsertAtCursorResponse
} from '@memry/contracts/agent-mcp-channels'
import { createWikiLinkInlineContent } from '@/components/note/content-area/wiki-link'
import { createLogger } from '@/lib/logger'

const log = createLogger('AgentMcpInsertAtCursor')

type InsertInline = (noteId: string, content: unknown[]) => boolean

/** Turns the request into editor inline content and says whether an editor took it. */
export function applyInsertAtCursor(
  request: AgentMcpInsertAtCursorRequest,
  insert: InsertInline
): AgentMcpInsertAtCursorResponse {
  const content = request.items.map((item) =>
    item.type === 'text' ? item.text : createWikiLinkInlineContent(item.title, '')
  )
  return insert(request.noteId, content) ? { ok: true } : { ok: false, reason: 'not-open' }
}

export function useAgentMcpInsertAtCursorResponder({
  enabled = true
}: { enabled?: boolean } = {}): void {
  useEffect(() => {
    if (!enabled) return undefined

    return window.api.onMainInvoke(async ({ requestId, channel, payload }) => {
      if (channel !== AgentMcpInsertAtCursorChannel) return

      const parsed = AgentMcpInsertAtCursorRequestSchema.safeParse(payload)
      if (!parsed.success) {
        log.error('Invalid insert-at-cursor request', parsed.error)
        window.api.respondToMainInvoke(requestId, { ok: false, reason: 'not-open' })
        return
      }

      try {
        const { insertInlineContentInActiveEditor } =
          await import('@/components/note/content-area/hooks/use-editor-sync')
        window.api.respondToMainInvoke(
          requestId,
          applyInsertAtCursor(parsed.data, insertInlineContentInActiveEditor)
        )
      } catch (error) {
        log.error('Failed to insert at cursor', error)
        window.api.respondToMainInvoke(requestId, { ok: false, reason: 'not-open' })
      }
    })
  }, [enabled])
}
