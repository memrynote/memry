import { ipcMain } from 'electron'

import { IosBetaChannels } from '@memry/contracts/ipc-channels'
import { IosBetaJoinInputSchema } from '@memry/contracts/ios-beta-api'

import { joinIosBeta } from '../ios-beta/join-ios-beta'
import { registerCommand } from './lib/register-command'

let registered = false

export const registerIosBetaHandlers = (): void => {
  if (registered) return
  registerCommand(IosBetaChannels.invoke.JOIN, IosBetaJoinInputSchema, joinIosBeta)
  registered = true
}

export const unregisterIosBetaHandlers = (): void => {
  if (!registered) return
  ipcMain.removeHandler(IosBetaChannels.invoke.JOIN)
  registered = false
}
