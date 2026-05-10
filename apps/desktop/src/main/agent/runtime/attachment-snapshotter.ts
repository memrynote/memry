import type { AttachmentInput } from '@memry/contracts/ipc-agent'

import type { MessageAttachment } from '../storage/types'

export async function snapshotAttachments(inputs: AttachmentInput[]): Promise<MessageAttachment[]> {
  const snapshotAt = Date.now()

  return inputs.map((input) => ({
    kind: input.kind,
    refId: input.ref_id,
    label: input.label,
    snapshotAt,
    snapshot:
      input.kind === 'folder'
        ? { mode: 'reference_only', path: input.ref_id }
        : { mode: 'reference_only', id: input.ref_id }
  }))
}
