import { googleProviderDefinition } from '../providers/google/provider-definition'
import { registerProvider } from './registry'

/**
 * Registers the providers this build ships with.
 *
 * Kept out of `registry.ts` so the registry never imports a provider and the
 * providers never import the registry's contents — the definitions only need
 * its types. Idempotent: handler registration runs more than once across a
 * window teardown/rebuild, and the tests call it directly.
 */
let registered = false

export function ensureBuiltInCalendarProviders(): void {
  if (registered) return
  registered = true
  registerProvider(googleProviderDefinition)
}

// Register on import as well, so a module that only reads the registry (an
// agent tool, a sync effect) cannot observe an empty one just because it
// loaded before the IPC handlers did.
ensureBuiltInCalendarProviders()
