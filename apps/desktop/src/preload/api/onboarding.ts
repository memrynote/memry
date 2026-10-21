import {
  OnboardingChannels,
  type OnboardingAgentStatus,
  type OnboardingSources
} from '@memry/contracts/onboarding-api'
import { invoke } from '../lib/ipc'

export const onboardingApi = {
  detectAgents: (): Promise<OnboardingAgentStatus[]> =>
    invoke(OnboardingChannels.invoke.DETECT_AGENTS),
  detectSources: (): Promise<OnboardingSources> => invoke(OnboardingChannels.invoke.DETECT_SOURCES),
  isMemryVault: (path: string): Promise<boolean> =>
    invoke(OnboardingChannels.invoke.IS_MEMRY_VAULT, path)
}
