import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

import { envelope } from './auth-service'
import { commands } from '../../../generated/bindings'
import { extractErrorMessage } from '@/lib/ipc-error'

/** `completeLinkingQr`'s answer while the approver has not approved yet; the poll goes on. */
export const LINK_NOT_APPROVED = 'Session not yet approved'

/**
 * Device linking (`sync/linking-service.ts`), in the envelopes the linking screens read: a poll
 * that is not approved yet, or refused for the rate limit, is a failure the screen polls past.
 */
export const linkingService = {
  /** Throws when the code cannot be made, as Electron's handler does. */
  generateLinkingQr: () => commands.syncGenerateLinkingQr(),

  linkViaQr: (input: { qrData: string }) =>
    envelope(
      async () => {
        const scan = await commands.syncLinkViaQr(input.qrData)
        return { status: 'waiting_approval' as const, verificationCode: scan.verificationCode }
      },
      { setup_session_expired: LINK_FAILURE_SETUP_SESSION_EXPIRED }
    ),

  completeLinkingQr: async (input: { sessionId: string }) => {
    const answer = await envelope(() => commands.syncCompleteLinkingQr(input.sessionId))
    if (!answer.success) return answer
    if (answer.status === 'waiting') return { success: false as const, error: LINK_NOT_APPROVED }
    if (answer.status === 'rateLimited') {
      return { success: false as const, error: 'Too many requests' }
    }
    return { success: true as const, vaults: answer.vaults?.map((vaultUuid) => ({ vaultUuid })) }
  },

  finalizeVaultChoice: (input: {
    sessionId: string
    parentFolderPath: string
    selectedVaultUuids: string[]
    primaryVaultUuid: string
  }) =>
    envelope(async () => {
      await commands.syncFinalizeVaultChoice(
        input.sessionId,
        input.parentFolderPath,
        input.selectedVaultUuids,
        input.primaryVaultUuid
      )
      return {}
    }),

  pickVaultFolder: async () => ({ path: await commands.syncPickVaultFolder() }),

  getLinkingSas: async (input: { sessionId: string }) => {
    try {
      return { verificationCode: await commands.syncGetLinkingSas(input.sessionId) }
    } catch (error) {
      return { error: extractErrorMessage(error, '') }
    }
  },

  approveLinking: (input: { sessionId: string }) =>
    envelope(async () => {
      await commands.syncApproveLinking(input.sessionId)
      return {}
    })
}
