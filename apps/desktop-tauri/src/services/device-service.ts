import { invoke } from '@/lib/ipc/invoke'

export interface Device {
  id: string
  name: string
  platform: string
  isCurrentDevice: boolean
  linkedAt: number
  lastActiveAt?: string | null
  lastSyncAt?: number
  createdAt?: string
}

export interface GetDevicesResult {
  devices: Device[]
  email: string
}

export interface DeviceMutationResult {
  success: boolean
  error?: string
}

export interface SetupFirstDeviceResult {
  success: boolean
  error?: string
  deviceId?: string
  email?: string
  recoveryPhrase?: string[]
  needsRecoverySetup?: boolean
}

export interface SetupNewAccountResult {
  success: boolean
  error?: string
  recoveryPhrase?: string[]
}

export const deviceService = {
  getDevices: (): Promise<GetDevicesResult> => {
    return invoke<GetDevicesResult>('sync_devices_get_devices')
  },

  removeDevice: (input: { deviceId: string }): Promise<DeviceMutationResult> => {
    return invoke<DeviceMutationResult>('sync_devices_remove_device', input)
  },

  renameDevice: (input: { deviceId: string; newName: string }): Promise<DeviceMutationResult> => {
    return invoke<DeviceMutationResult>('sync_devices_rename_device', input)
  }
}

export const setupService = {
  setupFirstDevice: (input: {
    provider: 'google'
    oauthToken: string
    state: string
  }): Promise<SetupFirstDeviceResult> => {
    return invoke<SetupFirstDeviceResult>('sync_setup_setup_first_device', input)
  },

  setupNewAccount: (): Promise<SetupNewAccountResult> => {
    return invoke<SetupNewAccountResult>('sync_setup_setup_new_account')
  },

  confirmRecoveryPhrase: (input: {
    confirmed: boolean
  }): Promise<{ success: boolean; error?: string }> => {
    return invoke<{ success: boolean; error?: string }>('sync_setup_confirm_recovery_phrase', input)
  }
}
