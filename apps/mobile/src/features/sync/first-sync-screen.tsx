import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { AUTH_GUTTER } from '@/features/auth/chrome'
import { withThousands } from '@/lib/format'
import type { FirstSyncProgress } from '@/sync/first-sync'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// 56 is not on the space scale and only this pair of boards uses it.
const BODY_TOP = 56
const TRACK_HEIGHT = 6
const STEP_HEIGHT = 44
const MARK_LANE = 20

type StepState = 'done' | 'running' | 'waiting'

/**
 * The board names five steps; these are the four the engine actually reports
 * plus the attachment note, so a row cannot claim progress nothing measures.
 * Order matches `FirstSyncProgress['phase']`.
 */
const STEPS: { label: string; phase: FirstSyncProgress['phase'] | 'keys' | 'attachments' }[] = [
  { label: 'Keys verified', phase: 'keys' },
  { label: 'Vault index', phase: 'refs' },
  { label: 'Notes, folders and tags', phase: 'metadata' },
  { label: 'Recent note bodies', phase: 'recent-bodies' },
  { label: 'Attachments — on demand', phase: 'attachments' }
]

const ORDER: FirstSyncProgress['phase'][] = ['refs', 'metadata', 'recent-bodies', 'done']

function stepState(step: (typeof STEPS)[number], progress: FirstSyncProgress): StepState {
  // Keys are proven by the fact that this screen is reachable at all, and
  // attachments are pulled on demand later, so neither tracks a phase.
  if (step.phase === 'keys') return 'done'
  if (step.phase === 'attachments') return 'waiting'
  const current = ORDER.indexOf(progress.phase)
  const mine = ORDER.indexOf(step.phase)
  if (mine < current) return 'done'
  return mine === current ? 'running' : 'waiting'
}

export interface FirstSyncScreenProps {
  progress: FirstSyncProgress
  onDismiss: () => void
}

/** First sync (Paper `10 · Auth — First sync`). Dismissible, never blocking. */
export function FirstSyncScreen({ progress, onDismiss }: FirstSyncScreenProps) {
  const c = useColors()
  const percent = Math.round(progress.fraction * 100)

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.body}>
        <View style={styles.heading}>
          <AppText variant="largeTitle">Bringing your vault down</AppText>
          <AppText variant="body" color={c.text.secondary}>
            Recent notes come first so you can start reading straight away. Older bodies download as
            you open them.
          </AppText>
        </View>

        <View style={styles.progress}>
          <View
            style={[styles.track, { backgroundColor: c.canvas.surfaceActive }]}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
          >
            <View style={[styles.fill, { width: `${percent}%`, backgroundColor: c.tint.base }]} />
          </View>
          <View style={styles.counter}>
            <AppText variant="footnote" color={c.text.secondary}>
              {progress.itemsTotal > 0
                ? `Items — ${withThousands(progress.itemsPulled)} of ${withThousands(progress.itemsTotal)}`
                : 'Preparing your vault'}
            </AppText>
            <AppText variant="footnote" color={c.text.secondary}>
              {percent}%
            </AppText>
          </View>
        </View>

        <View>
          {STEPS.map((step) => {
            const state = stepState(step, progress)
            return (
              <View key={step.label} style={styles.step}>
                <View style={styles.markLane}>
                  {state === 'done' ? (
                    <Icon name="check" size={18} color={c.text.primary} />
                  ) : state === 'running' ? (
                    <ActivityIndicator size="small" color={c.tint.base} />
                  ) : (
                    <View style={[styles.dot, { backgroundColor: c.text.tertiary }]} />
                  )}
                </View>
                <AppText
                  variant={state === 'running' ? 'bodyEmphasis' : 'body'}
                  color={state === 'waiting' ? c.text.tertiary : c.text.primary}
                >
                  {step.label}
                </AppText>
              </View>
            )
          })}
        </View>
      </View>

      <View style={styles.actions}>
        <Button
          label="Start using Memry now"
          variant="secondary"
          style={{ backgroundColor: c.canvas.background }}
          onPress={onDismiss}
        />
        <AppText variant="caption" color={c.text.secondary} style={styles.centered}>
          The app never waits on this. You can start using it now and let the rest arrive.
        </AppText>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, paddingHorizontal: AUTH_GUTTER, paddingTop: BODY_TOP, gap: space.s32 },
  heading: { gap: space.s8 },
  progress: { gap: 10 },
  track: { height: TRACK_HEIGHT, borderRadius: radius.full, overflow: 'hidden' },
  fill: { height: TRACK_HEIGHT, borderRadius: radius.full },
  counter: { flexDirection: 'row', justifyContent: 'space-between' },
  step: { height: STEP_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  // A fixed lane so the tick, the spinner and the dot leave the labels on one
  // vertical line whatever a row is doing.
  markLane: { width: MARK_LANE, flexShrink: 0, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: radius.full },
  actions: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8, gap: space.s4 },
  centered: { textAlign: 'center' }
})
