import type { AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'

let starter: (() => Promise<void>) | null = null
let startupPromise: Promise<void> | null = null
let started = false

const STOPPED_STATUS: AgentMcpStatus = { url: null, token: null, toolCount: 0 }

export function configureLazyAgentServices(nextStarter: (() => Promise<void>) | null): void {
  starter = nextStarter
  startupPromise = null
  started = false
}

export function areLazyAgentServicesStarted(): boolean {
  return started
}

export async function ensureLazyAgentServicesStarted(): Promise<void> {
  if (started) return
  if (!starter) throw new Error('No vault is open')

  startupPromise ??= starter().then(() => {
    started = true
  })
  await startupPromise
}

export async function getLazyAgentMcpStatus(): Promise<AgentMcpStatus> {
  if (!started) {
    if (!starter) return STOPPED_STATUS
    await ensureLazyAgentServicesStarted()
  }

  const { getPublicStatus } = await import('./mcp/lifecycle')
  return getPublicStatus()
}

export async function rotateLazyAgentMcpToken(): Promise<AgentMcpStatus> {
  await ensureLazyAgentServicesStarted()
  const { rotateToken, getPublicStatus } = await import('./mcp/lifecycle')
  rotateToken()
  return getPublicStatus()
}
