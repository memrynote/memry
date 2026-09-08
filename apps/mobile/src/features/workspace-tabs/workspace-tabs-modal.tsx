import { useRef, type MutableRefObject } from 'react'
import {
  FlatList,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'
import type { WorkspaceTab } from './model'
import { useWorkspaceTabs } from './provider'
import { workspaceTabCardWidth } from './layout'

export function WorkspaceTabsModal({ onNewTab }: { onNewTab: () => void }) {
  const { visible, setVisible } = useWorkspaceTabs()
  const pendingNewTab = useRef(false)
  const runPendingNewTab = (): void => {
    if (!pendingNewTab.current) return
    pendingNewTab.current = false
    onNewTab()
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={() => setVisible(false)}
      onDismiss={runPendingNewTab}
    >
      <SafeAreaProvider>
        <WorkspaceTabsContent
          pendingNewTabRef={pendingNewTab}
          runPendingNewTab={runPendingNewTab}
        />
      </SafeAreaProvider>
    </Modal>
  )
}

function WorkspaceTabsContent({
  pendingNewTabRef,
  runPendingNewTab
}: {
  pendingNewTabRef: MutableRefObject<boolean>
  runPendingNewTab: () => void
}) {
  const c = useColors()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const cardWidth = workspaceTabCardWidth(width - insets.left - insets.right)
  const { tabs, activeTabId, activate, close, setVisible } = useWorkspaceTabs()

  return (
    <SafeAreaView
      edges={['top', 'bottom', 'left', 'right']}
      style={[styles.screen, { backgroundColor: c.canvas.background }]}
    >
      <View style={[styles.header, { borderBottomColor: c.line.border }]}>
        <View style={styles.heading}>
          <AppText variant="title3">Tabs</AppText>
          <AppText variant="caption" color={c.text.secondary}>
            {tabs.length} open
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New tab"
          onPress={() => {
            pendingNewTabRef.current = true
            setVisible(false)
            if (Platform.OS !== 'ios') {
              void InteractionManager.runAfterInteractions(runPendingNewTab)
            }
          }}
          style={({ pressed }) => [
            styles.headerButton,
            pressed && { backgroundColor: c.canvas.surface }
          ]}
        >
          <Icon name="plus" size={22} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => setVisible(false)}
          style={styles.doneButton}
        >
          <AppText color={c.tint.text} style={styles.doneText}>
            Done
          </AppText>
        </Pressable>
      </View>

      <FlatList
        data={tabs}
        keyExtractor={(tab) => tab.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        renderItem={({ item }) => (
          <TabCard
            tab={item}
            width={cardWidth}
            active={item.id === activeTabId}
            onActivate={() => {
              activate(item.id)
              setVisible(false)
            }}
            onClose={() => {
              close(item.id)
              if (tabs.length === 1) setVisible(false)
            }}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <AppText variant="headline">No open tabs</AppText>
            <AppText variant="footnote" color={c.text.secondary}>
              Open a note to keep it here.
            </AppText>
          </View>
        }
      />
    </SafeAreaView>
  )
}

function TabCard({
  tab,
  width,
  active,
  onActivate,
  onClose
}: {
  tab: WorkspaceTab
  width: number
  active: boolean
  onActivate: () => void
  onClose: () => void
}) {
  const c = useColors()
  return (
    <View
      style={[
        styles.card,
        {
          width,
          backgroundColor: c.canvas.card,
          borderColor: active ? c.tint.base : c.line.border
        }
      ]}
    >
      <View style={[styles.cardHeader, { borderBottomColor: c.line.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${tab.title}`}
          accessibilityState={{ selected: active }}
          onPress={onActivate}
          style={styles.titleButton}
        >
          <AppText variant="footnote" numberOfLines={2} style={styles.cardTitle}>
            {tab.title}
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${tab.title}`}
          onPress={onClose}
          style={styles.closeButton}
        >
          <Icon name="close" size={18} color={c.text.secondary} />
        </Pressable>
      </View>
      <Pressable
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        onPress={onActivate}
        style={styles.preview}
      >
        <Icon name="note" size={24} color={c.text.secondary} />
        <AppText variant="subheadEmphasis" numberOfLines={3}>
          {tab.title}
        </AppText>
        <View style={[styles.lineLong, { backgroundColor: c.line.border }]} />
        <View style={[styles.lineShort, { backgroundColor: c.line.border }]} />
      </Pressable>
      <View style={[styles.cardFooter, { borderTopColor: c.line.border }]}>
        <AppText variant="caption" color={active ? c.tint.text : c.text.secondary}>
          {active ? 'Active' : 'Note'}
        </AppText>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingStart: sizes.gutter,
    paddingEnd: space.s8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s4
  },
  heading: { flex: 1, gap: space.s2 },
  headerButton: {
    width: sizes.tapTarget,
    height: sizes.tapTarget,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  doneButton: {
    minWidth: 58,
    minHeight: sizes.tapTarget,
    alignItems: 'center',
    justifyContent: 'center'
  },
  doneText: { fontWeight: '600' },
  grid: { padding: space.s12, gap: space.s8, flexGrow: 1 },
  row: { gap: space.s8 },
  card: {
    flexShrink: 0,
    height: 252,
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden'
  },
  cardHeader: {
    height: sizes.tapTarget,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center'
  },
  titleButton: {
    flex: 1,
    minWidth: 0,
    minHeight: sizes.tapTarget,
    justifyContent: 'center',
    paddingStart: space.s12
  },
  cardTitle: { fontWeight: '600' },
  closeButton: {
    width: sizes.tapTarget,
    height: sizes.tapTarget,
    alignItems: 'center',
    justifyContent: 'center'
  },
  preview: { flex: 1, padding: space.s12, gap: space.s12 },
  lineLong: { height: 5, width: '74%', borderRadius: radius.full },
  lineShort: { height: 5, width: '48%', borderRadius: radius.full },
  cardFooter: {
    height: space.s32,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingStart: space.s12,
    paddingEnd: space.s12,
    justifyContent: 'center'
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.s8 }
})
