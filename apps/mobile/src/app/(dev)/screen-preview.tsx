import { useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { FirstSyncScreen } from '@/features/sync/first-sync-screen'
import { SyncErrorScreen } from '@/features/sync/sync-error-screen'

const noop = () => {}

/**
 * Dev-only harness for screens that only appear mid-flow.
 *
 * First sync and its failure need a live session and a dropped connection to
 * reach, which makes them the two screens nobody ever looks at again after
 * they are written. `memry://screen-preview?screen=first-sync` renders one
 * full-bleed against its board.
 */
const SCREENS = {
  'first-sync': () => (
    <FirstSyncScreen
      progress={{ phase: 'metadata', fraction: 0.62, itemsTotal: 1000, itemsPulled: 620 }}
      onDismiss={noop}
    />
  ),
  'sync-error': () => (
    <SyncErrorScreen
      state={{
        lastSuccessAt: Date.now() - 2 * 60_000,
        lastFailure: { reason: 'error', at: Date.now() },
        failureCount: 1
      }}
      progress={{ phase: 'metadata', fraction: 0.62, itemsTotal: 1000, itemsPulled: 620 }}
      onRetry={noop}
      onContinue={noop}
    />
  )
} as const

export default function ScreenPreview() {
  const { screen } = useLocalSearchParams<{ screen?: keyof typeof SCREENS }>()
  const render = screen ? SCREENS[screen] : undefined
  if (!render) {
    return <AppText>{`Pass ?screen= one of: ${Object.keys(SCREENS).join(', ')}`}</AppText>
  }
  return render()
}
