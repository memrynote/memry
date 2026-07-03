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

  // Only block the pane on the disclosure state — that decides enablement vs.
  // conversation. Backend detection (backendStatuses) populates asynchronously
  // and the composer tolerates a null value, so it must not gate the whole pane
  // (otherwise a slow/failed backend probe leaves it stuck on "Loading…").
  if (state.disclosureAccepted === null) {
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
