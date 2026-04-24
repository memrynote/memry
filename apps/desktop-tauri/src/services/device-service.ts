import { invoke } from '@/lib/ipc/invoke'

export const deviceService = {
  getDevices: () => {
    return invoke('sync_devices_get_devices')
  },

  removeDevice: (input: { deviceId: string }) => {
    return invoke('sync_devices_remove_device', input)
  },

  renameDevice: (input: { deviceId: string; newName: string }) => {
    return invoke('sync_devices_rename_device', input)
  }
}

export const setupService = {
  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => {
    return invoke('sync_setup_setup_first_device', input)
  },

  setupNewAccount: () => {
    return invoke('sync_setup_setup_new_account')
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }) => {
    return invoke('sync_setup_confirm_recovery_phrase', input)
  }
}
