import { capability, sharedConfig } from './wdio.shared'

export const config = {
  ...sharedConfig,
  specs: ['./specs/**/*.e2e.ts'],
  exclude: ['./specs/two-device/**'],
  // One app per worker. CI raises it to the runner's vCPU count (`MEMRY_E2E_WORKERS`).
  maxInstances: Number(process.env.MEMRY_E2E_WORKERS) || 2,
  capabilities: [capability()]
}
