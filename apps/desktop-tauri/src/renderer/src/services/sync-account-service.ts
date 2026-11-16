import type {
  DeviceRevokedEvent,
  LinkingApprovedEvent,
  LinkingRequestEvent,
  SessionExpiredEvent
} from '@memry/contracts/ipc-events'
import type {
  ResolveVaultBindingResult,
  VaultBindingChoice,
  VaultBindingState
} from '@memry/contracts/ipc-sync-ops'

import { commands, events } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

/**
 * The account's side of sync over its Rust commands and events: sign-out, the open vault's
 * account binding, and what sync learns about the session (expiry, revocation, linking).
 */
export const syncAccountService = {
  /** One teardown: sync stops, the keychain and `sync` settings clear, vaults stay. */
  logout: (): Promise<{ success: boolean; keychainWarning?: string }> =>
    commands.syncLogout().then(({ success, keychainWarning }) => ({
      success,
      ...(keychainWarning ? { keychainWarning } : {})
    })),

  getVaultBinding: (): Promise<VaultBindingState> => commands.syncGetVaultBinding(),

  resolveVaultBinding: (choice: VaultBindingChoice): Promise<ResolveVaultBindingResult> =>
    commands.syncResolveVaultBinding(choice).then(({ success, state, error }) => ({
      success,
      state,
      ...(error ? { error } : {})
    }))
}

export const onSessionExpired = (callback: (event: SessionExpiredEvent) => void): (() => void) =>
  subscribeToEvent(events.authSessionExpiredEvent, callback)

export const onDeviceRevoked = (callback: (event: DeviceRevokedEvent) => void): (() => void) =>
  subscribeToEvent(events.syncDeviceRemovedEvent, callback)

export const onLinkingRequest = (callback: (event: LinkingRequestEvent) => void): (() => void) =>
  subscribeToEvent(events.syncLinkingRequestedEvent, callback)

export const onLinkingApproved = (callback: (event: LinkingApprovedEvent) => void): (() => void) =>
  subscribeToEvent(events.syncLinkingApprovedEvent, callback)

export const onVaultBindingChanged = (callback: (state: VaultBindingState) => void): (() => void) =>
  subscribeToEvent(events.syncVaultBindingChangedEvent, callback)
