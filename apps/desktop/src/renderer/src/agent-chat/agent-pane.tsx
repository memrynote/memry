import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'

import { ApprovalModal } from './approval-modal'
import { useAgentOptional } from './agent-context'
import { ConversationView } from './conversation-view'
import { DiffModal } from './diff-modal'
import { EmptyState } from './empty-state'
import { Enablement } from './enablement'

export function AgentPane(): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const [creating, setCreating] = useState(false)

  if (!agent) {
    return (
      <section
        className="flex h-full min-h-0 flex-col bg-sidebar"
        aria-label={t('agentChat.title')}
      >
        <div className="border-b border-sidebar-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('agentChat.title')}</h2>
        </div>
        <div className="min-h-0 flex-1" />
      </section>
    )
  }

  const { state } = agent

  if (state.disclosureAccepted === null || state.binaryStatus === null) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        {t('agentChat.loading')}
      </div>
    )
  }

  if (!state.disclosureAccepted) {
    return <Enablement onAccept={agent.acceptDisclosure} />
  }

  if (!state.activeConversationId) {
    return (
      <EmptyState
        binaryStatus={state.binaryStatus}
        creating={creating}
        onCreateConversation={async () => {
          setCreating(true)
          try {
            await agent.createConversation()
          } finally {
            setCreating(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <ConversationView conversationId={state.activeConversationId} />
      <ApprovalModal />
      <DiffModal />
    </>
  )
}

export default AgentPane
