import { MEMORY_DEBUG_DEFAULT_PORT, MEMORY_DEBUG_HOST } from './memory-snapshot-types'
import type { DebugMemorySnapshot, MemoryScenario } from './memory-snapshot-types'

interface JsonObject {
  [key: string]: unknown
}

export interface MemoryControlClient {
  getVaultPath(): Promise<string | null>
  openVault(vaultPath: string): Promise<string | null>
  captureSnapshot(input: {
    scenario: MemoryScenario
    label: string
    branch: string
  }): Promise<DebugMemorySnapshot>
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Memory control request failed with HTTP ${response.status}`
    throw new Error(message)
  }

  return payload as T
}

async function requestJson<T>(
  port: number,
  pathname: string,
  init?: RequestInit & { body?: BodyInit | null }
): Promise<T> {
  const response = await fetch(`http://${MEMORY_DEBUG_HOST}:${port}${pathname}`, init)
  return readJson<T>(response)
}

function postBody(body: JsonObject): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

export function createMemoryControlClient(port = MEMORY_DEBUG_DEFAULT_PORT): MemoryControlClient {
  return {
    async getVaultPath() {
      const status = await requestJson<{ vaultPath: string | null }>(port, '/vault/status')
      return status.vaultPath
    },
    async openVault(vaultPath: string) {
      const status = await requestJson<{ vaultPath: string | null }>(
        port,
        '/vault/open',
        postBody({ vaultPath })
      )
      return status.vaultPath
    },
    captureSnapshot(input) {
      return requestJson<DebugMemorySnapshot>(port, '/memory/snapshot', postBody(input))
    }
  }
}
