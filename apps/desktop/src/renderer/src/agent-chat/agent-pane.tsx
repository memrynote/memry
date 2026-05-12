import { useT } from '@memry/i18n/renderer'

import { useAgentOptional } from './agent-context'
import { ConversationView } from './conversation-view'
import { Enablement } from './enablement'

export function AgentPane(): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()

  if (!agent) {
    return (
      <section
        className="flex h-full min-h-0 flex-col bg-background"
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

  if (state.disclosureAccepted === null || state.backendStatuses === null) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        {t('agentChat.loading')}
      </div>
    )
  }

  if (!state.disclosureAccepted) {
    return <Enablement onAccept={agent.acceptDisclosure} />
  }

  return <ConversationView conversationId={state.activeConversationId} />
}

export default AgentPane
