import { decryptItemFromPull, SignatureVerificationError } from './decrypt'
import type { DecryptedPullItem, DecryptionFailure, PullItemForDecrypt } from './worker-protocol'
import { isCryptoErrorMessage } from './worker-protocol'

export type DecryptSingleResult =
  | { ok: true; item: DecryptedPullItem }
  | { ok: false; failure: DecryptionFailure }

export function decryptSingleItem(
  item: PullItemForDecrypt,
  vaultKey: Uint8Array,
  signerPublicKey: Uint8Array
): DecryptSingleResult {
  try {
    const result = decryptItemFromPull({
      ...item,
      metadata:
        item.clock || item.stateVector
          ? {
              ...(item.clock ? { clock: item.clock } : {}),
              ...(item.stateVector ? { stateVector: item.stateVector } : {})
            }
          : undefined,
      vaultKey,
      signerPublicKey
    })

    const contentStr = new TextDecoder().decode(result.content)
    const operation = item.deletedAt ? 'delete' : (item.operation ?? 'update')

    return {
      ok: true,
      item: {
        id: item.id,
        type: item.type,
        operation,
        content: contentStr,
        clock: item.clock,
        deletedAt: item.deletedAt,
        signerDeviceId: item.signerDeviceId
      }
    }
  } catch (err) {
    const isCryptoError =
      err instanceof SignatureVerificationError ||
      (err instanceof Error && isCryptoErrorMessage(err.message))

    return {
      ok: false,
      failure: {
        id: item.id,
        type: item.type,
        signerDeviceId: item.signerDeviceId,
        error: err instanceof Error ? err.message : String(err),
        isCryptoError
      }
    }
  }
}
