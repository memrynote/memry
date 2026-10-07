import {
  desktopOperationJsonSchema,
  desktopOperationParamNames,
  desktopOperationRequiredCount,
  type DesktopArgsJsonSchema
} from '@memry/contracts/agent-desktop-api-args'
import {
  AgentMcpDesktopOperations,
  AgentMcpDesktopWriteOperations,
  type AgentMcpDesktopOperation
} from '@memry/contracts/agent-mcp-channels'

type DesktopTool = 'vault_desktop_read' | 'vault_desktop_write'

export interface DesktopOperationSummary {
  operation: AgentMcpDesktopOperation
  tool: DesktopTool
  /** `notes.list(options?)`: the parameters in call order, `?` on optional ones. */
  call: string
}

export interface DesktopOperationDescription extends DesktopOperationSummary {
  requires_approval: boolean
  params: Array<{ name: string; required: boolean }>
  args_schema: DesktopArgsJsonSchema
}

function summary(operation: AgentMcpDesktopOperation): DesktopOperationSummary {
  const required = desktopOperationRequiredCount(operation)
  const params = desktopOperationParamNames(operation).map((name, index) =>
    index < required ? name : `${name}?`
  )
  return {
    operation,
    tool: (AgentMcpDesktopWriteOperations as readonly string[]).includes(operation)
      ? 'vault_desktop_write'
      : 'vault_desktop_read',
    call: `${operation}(${params.join(', ')})`
  }
}

/** What `vault_desktop_describe` replies: one operation in full, or every operation's call shape. */
export function describeDesktopOperation(
  operation: AgentMcpDesktopOperation | undefined
): DesktopOperationDescription | { operations: DesktopOperationSummary[] } {
  if (!operation) return { operations: AgentMcpDesktopOperations.map(summary) }
  const required = desktopOperationRequiredCount(operation)
  const base = summary(operation)
  return {
    ...base,
    requires_approval: base.tool === 'vault_desktop_write',
    params: desktopOperationParamNames(operation).map((name, index) => ({
      name,
      required: index < required
    })),
    args_schema: desktopOperationJsonSchema(operation)
  }
}
