import { useAuth } from '@/contexts/auth-context'
import { useSyncOptional } from '@/contexts/sync-context'
import { useAppCommands } from './use-command-impls'

/**
 * The owner of the sync commands, which are the buttons in the sidebar's sync
 * popover. Each is available only when the popover would show it as usable: signed
 * in, and not offline or on a plan without sync.
 */
export function useSyncCommands(): void {
  const { state: auth } = useAuth()
  const sync = useSyncOptional()
  // Main reports `local_only` on a plan without sync, which the renderer's status union omits.
  const status: string | undefined = sync?.state.status
  const reachable =
    auth.status === 'authenticated' && status !== 'offline' && status !== 'local_only'

  useAppCommands('sync', {
    'sync.syncNow': {
      enabled: reachable && status !== 'syncing',
      run: async () => {
        await sync?.triggerSync()
      }
    },
    'sync.pause': {
      enabled: reachable && status !== 'paused',
      run: async () => {
        await sync?.pause('command_palette')
      }
    },
    'sync.resume': {
      enabled: reachable && status === 'paused',
      run: async () => {
        await sync?.resume('command_palette')
      }
    }
  })
}
