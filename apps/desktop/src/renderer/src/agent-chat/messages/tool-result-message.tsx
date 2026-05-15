import type { Message } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai-elements/tool'

export function ToolResultMessage({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useT('common')

  if (message.content.role !== 'tool_result') return null

  const { data } = message.content

  return (
    <Tool defaultOpen={false}>
      <ToolHeader
        title={t('agentChat.toolResult.label')}
        state={data.ok ? 'completed' : 'failed'}
      />
      <ToolContent>
        <ToolOutput
          errorText={data.ok ? undefined : data.error?.message}
          output={data.ok ? data.data : data.error}
        />
      </ToolContent>
    </Tool>
  )
}
