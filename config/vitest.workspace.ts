import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  '../apps/desktop/config/vitest.config.ts',
  '../apps/sync-server',
])
