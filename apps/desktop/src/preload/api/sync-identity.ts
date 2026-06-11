import { AccountChannels } from '@memry/contracts/ipc-channels'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'
import { invoke } from '../lib/ipc'

export const syncAuth = {
  requestOtp: (input: { email: string }) => invoke(SYNC_CHANNELS.AUTH_REQUEST_OTP, input),
  verifyOtp: (input: { email: string; code: string }) =>
    invoke(SYNC_CHANNELS.AUTH_VERIFY_OTP, input),
  resendOtp: (input: { email: string }) => invoke(SYNC_CHANNELS.AUTH_RESEND_OTP, input),
  initOAuth: (input: { provider: 'google' }) => invoke(SYNC_CHANNELS.AUTH_INIT_OAUTH, input),
  refreshToken: () => invoke(SYNC_CHANNELS.AUTH_REFRESH_TOKEN),
  logout: () => invoke(SYNC_CHANNELS.AUTH_LOGOUT)
}

export const syncSetup = {
  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) =>
    invoke(SYNC_CHANNELS.SETUP_FIRST_DEVICE, input),
  setupNewAccount: () => invoke(SYNC_CHANNELS.SETUP_NEW_ACCOUNT),
  confirmRecoveryPhrase: (input: { confirmed: boolean }) =>
    invoke(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, input),
  getRecoveryPhrase: (): Promise<string | null> =>
    invoke<string | null>(SYNC_CHANNELS.GET_RECOVERY_PHRASE)
}

export const syncLinking = {
  generateLinkingQr: () => invoke(SYNC_CHANNELS.GENERATE_LINKING_QR),
  linkViaQr: (input: { qrData: string; provider?: string; oauthToken?: string }) =>
    invoke(SYNC_CHANNELS.LINK_VIA_QR, input),
  linkViaRecovery: (input: { recoveryPhrase: string }) =>
    invoke(SYNC_CHANNELS.LINK_VIA_RECOVERY, input),
  approveLinking: (input: { sessionId: string }) => invoke(SYNC_CHANNELS.APPROVE_LINKING, input),
  getLinkingSas: (input: { sessionId: string }) => invoke(SYNC_CHANNELS.GET_LINKING_SAS, input),
  completeLinkingQr: (input: { sessionId: string }) =>
    invoke(SYNC_CHANNELS.COMPLETE_LINKING_QR, input),
  finalizeVaultChoice: (input: {
    sessionId: string
    parentFolderPath: string
    selectedVaultUuids: string[]
    primaryVaultUuid: string
  }) => invoke(SYNC_CHANNELS.FINALIZE_VAULT_CHOICE, input),
  pickVaultFolder: () => invoke(SYNC_CHANNELS.PICK_VAULT_FOLDER, {})
}

export const accountApi = {
  getInfo: () => invoke(AccountChannels.invoke.GET_INFO),
  signOut: () => invoke(AccountChannels.invoke.SIGN_OUT),
  startCheckout: () => invoke(AccountChannels.invoke.START_CHECKOUT),
  getBillingStatus: () => invoke(AccountChannels.invoke.GET_BILLING_STATUS),
  refreshBillingStatus: (input?: { transactionId?: string }) =>
    invoke(AccountChannels.invoke.REFRESH_BILLING_STATUS, input),
  openBillingPortal: () => invoke(AccountChannels.invoke.OPEN_BILLING_PORTAL)
}

export const syncDevices = {
  getDevices: () => invoke(SYNC_CHANNELS.GET_DEVICES),
  removeDevice: (input: { deviceId: string }) => invoke(SYNC_CHANNELS.REMOVE_DEVICE, input),
  renameDevice: (input: { deviceId: string; newName: string }) =>
    invoke(SYNC_CHANNELS.RENAME_DEVICE, input)
}
