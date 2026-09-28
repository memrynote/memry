export type BackendEvent =
  | { kind: 'assistant_delta'; text: string }
  /**
   * Visible model reasoning. `startsBlock` marks the first piece of a new
   * thinking block (Claude) or reasoning item (Codex), so the turn can put a
   * paragraph break between blocks instead of running them together.
   */
  | { kind: 'reasoning_delta'; text: string; startsBlock: boolean }
  | { kind: 'tool_use'; toolUseId: string; name: string; args: unknown }
  | {
      kind: 'tool_result'
      toolUseId: string
      ok: boolean
      data?: unknown
      error?: { code: string; message: string }
    }
  | { kind: 'error'; message: string }
  | { kind: 'message_stop' }
  | { kind: 'noop' }
  | { kind: 'unknown'; raw: unknown }
