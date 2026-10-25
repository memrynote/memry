import { capability, sharedConfig } from './wdio.shared'

// Instances A and B; the launcher gives each a free port.
export const config = {
  ...sharedConfig,
  specs: ['./specs/two-device/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: { A: { capabilities: capability() }, B: { capabilities: capability() } }
}
