export type BackendEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; args: unknown }
  | {
      kind: 'tool_result'
      toolUseId: string
      ok: boolean
      data?: unknown
      error?: { code: string; message: string }
    }
  | { kind: 'message_stop' }
  | { kind: 'unknown'; raw: unknown }
