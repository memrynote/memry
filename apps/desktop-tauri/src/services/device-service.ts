import { invoke } from '@/lib/ipc/invoke'
import type {
  DeviceView,
  SetupNewAccountInput,
  SetupResultView,
  SimpleSuccess,
  SyncDevicesGetDevicesResult,
  SyncDevicesMutationResult
} from '@/generated/bindings'

export type Device = DeviceView & {
  /** UI-only convenience: when supplied, prefer over `lastSyncAt`. */
  lastActiveAt?: string | null
}

export type GetDevicesResult = {
  devices: Device[]
  email: string
}

export type DeviceMutationResult = SyncDevicesMutationResult

export type SetupFirstDeviceResult = SetupResultView

export type SetupNewAccountResult = SetupResultView

function adaptGetDevicesResult(result: SyncDevicesGetDevicesResult): GetDevicesResult {
  return {
    devices: result.devices,
    email: result.email ?? ''
  }
}

export const deviceService = {
  getDevices: async (): Promise<GetDevicesResult> => {
    const result = await invoke<SyncDevicesGetDevicesResult>('sync_devices_get_devices')
    return adaptGetDevicesResult(result)
  },

  removeDevice: (input: { deviceId: string }): Promise<DeviceMutationResult> => {
    return invoke<DeviceMutationResult>('sync_devices_remove_device', { input })
  },

  renameDevice: (input: { deviceId: string; newName: string }): Promise<DeviceMutationResult> => {
    return invoke<DeviceMutationResult>('sync_devices_rename_device', { input })
  }
}

export const setupService = {
  setupFirstDevice: (input: {
    provider: 'google'
    oauthToken: string
    state: string
  }): Promise<SetupFirstDeviceResult> => {
    return invoke<SetupFirstDeviceResult>('sync_setup_setup_first_device', { input })
  },

  setupNewAccount: (input: SetupNewAccountInput): Promise<SetupNewAccountResult> => {
    return invoke<SetupNewAccountResult>('sync_setup_setup_new_account', { input })
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }): Promise<SimpleSuccess> => {
    return invoke<SimpleSuccess>('sync_setup_confirm_recovery_phrase', { input })
  }
}
