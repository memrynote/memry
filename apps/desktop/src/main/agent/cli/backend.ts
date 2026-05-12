import type { AgentBackendId } from '@memry/contracts/ipc-agent'

import { createCodexStreamParser } from './codex-stream-parser'
import { createStreamParser, type StreamParser } from './stream-parser'
import type { BackendEvent } from './types'

export function createBackendStreamParser(
  backend: AgentBackendId,
  onEvent: (event: BackendEvent) => void
): StreamParser {
  if (backend === 'codex_cli') {
    return createCodexStreamParser(onEvent)
  }
  return createStreamParser(onEvent)
}
