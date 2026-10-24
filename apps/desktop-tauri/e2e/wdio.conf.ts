import { capability, sharedConfig } from './wdio.shared'

export const config = {
  ...sharedConfig,
  specs: ['./specs/**/*.e2e.ts'],
  exclude: ['./specs/two-device/**'],
  maxInstances: 2,
  capabilities: [capability()]
}
