import { usePageCommands } from './use-page-commands'
import { useSyncCommands } from './use-sync-commands'

/**
 * The owners of the commands that need the workspace's contexts: tabs, settings,
 * feature flags, auth and sync. Render once, inside the vault workspace's providers.
 */
export function WorkspaceCommandOwners(): null {
  usePageCommands()
  useSyncCommands()
  return null
}
