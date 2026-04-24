import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { mockRouter } from './mocks'

/**
 * Typed wrapper around Tauri's invoke.
 *
 * At M1, every call is routed through the mock router to produce fake data
 * so the ported Electron renderer can render every page. Subsequent milestones
 * (M2+) implement real Rust commands; the wrapper flips to Tauri-backed
 * invoke per-command as implementations come online by adding entries to
 * `realCommands`.
 */
export async function invoke<TResponse = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<TResponse> {
  if (shouldUseMock(cmd)) {
    return mockRouter<TResponse>(cmd, args)
  }
  return tauriInvoke<TResponse>(cmd, args ?? {})
}

/**
 * Decides whether a command should be served by the mock router or routed to
 * the real Tauri backend. At M1, every command uses mock. Future milestones
 * extend the `realCommands` set with commands whose Rust implementation has
 * landed.
 */
const realCommands = new Set<string>([
  // No real commands at M1 — all mocked. M2+ adds entries here.
])

function shouldUseMock(cmd: string): boolean {
  if (import.meta.env.VITE_MOCK_IPC === 'false') {
    return false
  }
  return !realCommands.has(cmd)
}
