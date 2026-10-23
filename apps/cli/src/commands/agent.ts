import type { MemryApp } from '../app-core/memry-app.ts'
import { hasFlag, print, requireFirst, type CliIo, type ParsedCli } from '../cli-support.ts'

/** Agent commands added for desktop parity. Returns false for a subcommand it does not own. */
export async function runAgentExtras(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  const { agentExtras } = app
  switch (parsed.subcommand) {
    case 'conversations':
      print(io, parsed.json, await agentExtras.conversations())
      return true
    case 'conversation': {
      const id = requireFirst(parsed.positionals, 'agent conversation id')
      const conversation = await agentExtras.conversation(id)
      if (!conversation) throw new Error(`Agent conversation not found: ${id}`)
      print(io, parsed.json, conversation)
      return true
    }
    case 'preferences':
      await agentExtras.preferences()
      return true
    case 'set-preferences':
      await agentExtras.setPreferences()
      return true
    case 'local-models':
      print(io, parsed.json, await agentExtras.localModels())
      return true
    case 'test-local':
      print(io, parsed.json, await agentExtras.testLocal())
      return true
    case 'mcp-status':
      await agentExtras.mcpStatus()
      return true
    case 'mcp': {
      const action = requireFirst(parsed.positionals, 'mcp action')
      if (action === 'status') {
        await agentExtras.mcpStatus()
        return true
      }
      if (action === 'rotate-token') {
        if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to rotate the MCP token')
        await agentExtras.rotateMcpToken()
        return true
      }
      throw new Error('Usage: memrynote [--vault <path>] agent mcp status|rotate-token')
    }
    default:
      return false
  }
}
