import { useState } from 'react'
import { MotionConfig } from 'motion/react'
import { useTabSessionPersistence } from '@/contexts/tabs/persistence'
import { UpdateReleaseNotesTabOpener } from '@/components/updater/update-release-notes-tab-opener'
import { useThemeSync } from '@/hooks/use-theme-sync'
import { useWeekStartSync } from '@/hooks/use-week-start-sync'
import { wasEnteredBySwitch } from '@/lib/vault-switch-state'

// =============================================================================
// THEME SYNC MANAGER (inside ThemeProvider)
// =============================================================================

export function ThemeSyncManager({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { reduceMotion } = useThemeSync()
  useWeekStartSync()
  // 'user' follows the OS; motion's own default ('never') would ignore it.
  return (
    <MotionConfig reducedMotion={reduceMotion === 'on' ? 'always' : 'user'}>
      {children}
    </MotionConfig>
  )
}

// =============================================================================
// TAB PERSISTENCE MANAGER (inside TabProvider)
// =============================================================================

/**
 * Component that enables tab session persistence.
 * Must be rendered inside TabProvider.
 */
export function TabPersistenceManager({
  vaultPath,
  children
}: {
  vaultPath: string | null
  children: React.ReactNode
}): React.JSX.Element {
  // Restore the stored session on mount, and hold the debounced auto-save until
  // that restore has landed — otherwise the save writes the provider's default
  // Home tab over the session the restore is still on its way to read.
  //
  // The vault path decides which session that is: each vault keeps its own tabs,
  // so switching reads the other vault's set instead of destroying either.
  //
  // "Restore session on start" is about launching the app. A vault entered by
  // an in-app switch always comes back as it was left, tabs and all; read once
  // at mount, since this tree lives exactly as long as the vault is open.
  const [enteredBySwitch] = useState(() => wasEnteredBySwitch(vaultPath))
  const { isRestoring } = useTabSessionPersistence({
    vaultPath,
    restoreFullSession: enteredBySwitch
  })

  return (
    <>
      {children}
      {/* Opens the ephemeral read-only release-notes tab after an update+restart.
          Mounted only once the session restore has settled: RESTORE_SESSION replaces
          the whole tab state, so a tab opened before it would be silently wiped
          (and its one-shot stash already consumed). */}
      {!isRestoring && <UpdateReleaseNotesTabOpener />}
    </>
  )
}
