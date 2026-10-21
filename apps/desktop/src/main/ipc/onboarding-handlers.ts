import { ipcMain } from 'electron'
import { OnboardingChannels } from '@memry/contracts/onboarding-api'
import { createHandler, createStringHandler } from './validate'
import { isVaultInitialized } from '../vault/init'
import { detectAgents, detectSources } from '../onboarding/detect'

/** Registered at app start: the first-run wizard calls these before any vault is open. */
export function registerOnboardingHandlers(): void {
  ipcMain.handle(OnboardingChannels.invoke.DETECT_AGENTS, createHandler(detectAgents))
  ipcMain.handle(OnboardingChannels.invoke.DETECT_SOURCES, createHandler(detectSources))
  ipcMain.handle(
    OnboardingChannels.invoke.IS_MEMRY_VAULT,
    createStringHandler((path) => isVaultInitialized(path))
  )
}

export function unregisterOnboardingHandlers(): void {
  ipcMain.removeHandler(OnboardingChannels.invoke.DETECT_AGENTS)
  ipcMain.removeHandler(OnboardingChannels.invoke.DETECT_SOURCES)
  ipcMain.removeHandler(OnboardingChannels.invoke.IS_MEMRY_VAULT)
}
