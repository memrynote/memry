import { z } from 'zod'

export const AgentMcpChannels = {
  invoke: {
    GET_STATUS: 'agent_mcp:get_status',
    ['ROTATE_TOKEN']: 'agent_mcp:rotate_token'
  }
} as const

export const AgentMcpStatusSchema = z.object({
  url: z.string().nullable(),
  ['token']: z.string().nullable(),
  toolCount: z.number().int().nonnegative()
})

export type AgentMcpStatus = z.infer<typeof AgentMcpStatusSchema>
