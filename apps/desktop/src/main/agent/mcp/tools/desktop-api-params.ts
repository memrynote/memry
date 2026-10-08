import {
  desktopOperationArgsSchema,
  desktopOperationParamNames
} from '@memry/contracts/agent-desktop-api-args'
import type { AgentMcpDesktopApiRequest } from '@memry/contracts/agent-mcp-channels'

import { AgentToolError } from '../errors'
import { desktopArgIssues, formatDesktopArgIssue } from './desktop-api-issues'

/**
 * Refuses a desktop API call whose arguments do not match the operation's
 * schema in `@memry/contracts/agent-desktop-api-args`, naming each field, the
 * type it takes, the allowed values and what was sent. The args are forwarded
 * unchanged when they match, so the IPC handler sees exactly what it did
 * before. The responder spreads `args` into the preload call, which would drop
 * an argument past the last parameter without an error, so that is refused
 * too.
 */
export function assertDesktopApiArgs({ operation, args }: AgentMcpDesktopApiRequest): void {
  const params = desktopOperationParamNames(operation)
  const describe = `vault_desktop_describe with operation "${operation}" returns the full argument schema.`
  if (args.length > params.length) {
    const takes =
      params.length === 0
        ? 'takes no arguments'
        : `takes ${params.length} argument${params.length === 1 ? '' : 's'} (${params.join(', ')})`
    throw new AgentToolError(
      'VALIDATION',
      `${operation} ${takes}, but this call passed ${args.length}. Nothing was run.`,
      { operation, params, received: args.length }
    )
  }

  const result = desktopOperationArgsSchema(operation).safeParse(args)
  if (result.success) return
  const issues = desktopArgIssues(operation, args, result.error.issues)
  const unknown = issues.filter((issue) => issue.unknown).map((issue) => issue.field)
  if (unknown.length === issues.length) {
    throw new AgentToolError(
      'VALIDATION',
      `${operation} does not take ${unknown.join(', ')}. Nothing was run. ${describe}`,
      { operation, unknown, issues }
    )
  }
  throw new AgentToolError(
    'VALIDATION',
    `${operation} arguments do not match its schema: ` +
      `${issues.map(formatDesktopArgIssue).join('; ')}. Nothing was run. ${describe}`,
    { operation, params, issues }
  )
}
