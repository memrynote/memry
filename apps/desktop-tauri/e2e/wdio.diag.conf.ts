import { capability, sharedConfig } from './wdio.shared'

// DIAG #3973 (throwaway branch).
export const config = {
  ...sharedConfig,
  specFileRetries: 0,
  specs: ['./specs/diag/*.e2e.ts'],
  maxInstances: Number(process.env.MEMRY_E2E_WORKERS) || 2,
  capabilities: [capability()]
}
