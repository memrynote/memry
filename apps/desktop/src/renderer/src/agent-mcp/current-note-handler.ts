import { useEffect } from 'react'

import { useActiveTab } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'
import { extractMarkdownFromActiveEditor } from '@/components/note/content-area/hooks/use-editor-sync'

const log = createLogger('AgentMcpCurrentNote')
const CURRENT_NOTE_CHANNEL = 'agent_mcp:get_current_note'

export function useAgentMcpCurrentNoteResponder(): void {
  const activeTab = useActiveTab()
  const activeNoteId = activeTab?.type === 'note' ? activeTab.entityId : undefined
  const activeNoteTitle = activeTab?.type === 'note' ? activeTab.title : undefined

  useEffect(() => {
    return window.api.onMainInvoke(async ({ requestId, channel }) => {
      if (channel !== CURRENT_NOTE_CHANNEL) return

      if (!activeNoteId) {
        window.api.respondToMainInvoke(requestId, null)
        return
      }

      try {
        const markdown = await extractMarkdownFromActiveEditor(activeNoteId)
        if (markdown === null) {
          window.api.respondToMainInvoke(requestId, null)
          return
        }

        window.api.respondToMainInvoke(requestId, {
          id: activeNoteId,
          title: activeNoteTitle ?? 'Untitled',
          content_markdown: markdown,
          tags: []
        })
      } catch (error) {
        log.error('Failed to snapshot current note', error)
        window.api.respondToMainInvoke(requestId, null)
      }
    })
  }, [activeNoteId, activeNoteTitle])
}
