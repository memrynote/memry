import type { PreviewDiffResponse } from '@memry/contracts/ipc-agent'

import type { VaultServiceHandles } from '../mcp/tools/handles'
import { buildChangePreview } from './build-change-preview'

export { buildChangePreview } from './build-change-preview'

/**
 * The IPC answer for one pending approval.
 *
 * `title`, `current` and `candidate` are the legacy note-body triple, filled
 * from the typed preview so a renderer that has not learned about `preview`
 * yet still draws the old two-column view for body changes, and an empty one
 * rather than a broken one for everything else.
 */
export async function buildPreviewDiffResponse(
  input: { toolName: string; args: unknown },
  handles: VaultServiceHandles
): Promise<PreviewDiffResponse> {
  const preview = await buildChangePreview(input.toolName, input.args, handles)
  return {
    title: preview.item.title,
    current: preview.body?.current ?? '',
    candidate: preview.body?.candidate ?? '',
    preview
  }
}
