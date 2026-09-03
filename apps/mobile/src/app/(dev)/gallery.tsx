import { useState, type ReactNode } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Banner } from '@/components/ui/banner'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { FAB } from '@/components/ui/fab'
import { Icon, iconNames, type IconName } from '@/components/ui/icon'
import { ListRow } from '@/components/ui/list-row'
import { NavBarInline, NavBarLargeTitle } from '@/components/ui/nav-bar'
import { SearchField } from '@/components/ui/search-field'
import { SectionHeader } from '@/components/ui/section-header'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { SheetHandle } from '@/components/ui/sheet-handle'
import { SkeletonRow } from '@/components/ui/skeleton-row'
import { SyncProgress } from '@/components/ui/sync-progress'
import { TabBar } from '@/components/ui/tab-bar'
import { TextField } from '@/components/ui/text-field'
import { Toast } from '@/components/ui/toast'
import { ContextMenu } from '@/components/ui/context-menu'
import { PromptDialog } from '@/components/ui/prompt-dialog'
import { rowActionGroups } from '@/features/notes/row-actions'
import { TreeRow, TreeSectionHeader } from '@/components/ui/tree-row'
import { NOTE_FILE_TYPE_TONE, type NoteFileType } from '@/features/notes/tree'
import { sizes, space } from '@/theme/primitives'
import { textStyles, type TextVariant } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

const noop = () => {}

const textVariants = Object.keys(textStyles) as TextVariant[]

const noteFileTypes = Object.keys(NOTE_FILE_TYPE_TONE) as NoteFileType[]

const tabs: { key: string; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'notes', label: 'Notes', icon: 'note' },
  { key: 'tasks', label: 'Tasks', icon: 'task' },
  { key: 'journal', label: 'Journal', icon: 'journal' },
  { key: 'more', label: 'More', icon: 'more' }
]

const segments = ['Notes', 'Tasks', 'Journal'] as const

// `?section=nav bar` narrows the gallery to one section so a screenshot lines
// up against its Figma board without anyone scrolling to find it.
function useSectionFilter() {
  const { section } = useLocalSearchParams<{ section?: string }>()
  return section?.trim().toLowerCase() ?? null
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const filter = useSectionFilter()
  if (filter && !title.toLowerCase().includes(filter)) return null
  return (
    <View style={styles.section}>
      <AppText variant="title3">{title}</AppText>
      {children}
    </View>
  )
}

function Demo({ name, children }: { name: string; children: ReactNode }) {
  const c = useColors()
  return (
    <View style={styles.demo}>
      <AppText variant="caption" color={c.text.secondary}>
        {name}
      </AppText>
      {children}
    </View>
  )
}

export default function GalleryScreen() {
  const c = useColors()
  const filter = useSectionFilter()
  const [tab, setTab] = useState('home')
  const [filled, setFilled] = useState('Weekly review')
  const [invalid, setInvalid] = useState('a')
  const [segment, setSegment] = useState<(typeof segments)[number]>('Notes')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [menuKind, setMenuKind] = useState<'folder' | 'note' | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [researchExpanded, setResearchExpanded] = useState(true)

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {filter ? null : <AppText variant="largeTitle">Component gallery</AppText>}

        <Section title="Type ramp">
          {textVariants.map((variant) => (
            <View key={variant} style={styles.rampRow}>
              <AppText variant={variant}>{variant}</AppText>
              <AppText variant="caption" color={c.text.secondary}>
                {textStyles[variant].fontSize} / {textStyles[variant].lineHeight}
              </AppText>
            </View>
          ))}
        </Section>

        <Section title="Icons">
          <View style={styles.iconGrid}>
            {iconNames.map((name) => (
              <View key={name} style={styles.iconCell}>
                <Icon name={name} />
                <AppText variant="caption" color={c.text.secondary} style={styles.iconLabel}>
                  {name}
                </AppText>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Nav bar">
          <Demo name="shell/Nav Bar — Large Title">
            <NavBarLargeTitle
              title="Notes"
              actions={[
                { icon: 'search', label: 'Search', onPress: noop },
                { icon: 'plus', label: 'New note', onPress: noop }
              ]}
            />
          </Demo>
          <Demo name="shell/Nav Bar — Large Title, no actions">
            <NavBarLargeTitle title="Search" />
          </Demo>
          <Demo name="shell/Nav Bar — Inline + Back">
            <NavBarInline
              title="Weekly review"
              back={{ label: 'Back', onPress: noop }}
              actions={[{ icon: 'more', label: 'Note actions', onPress: noop }]}
            />
          </Demo>
          <Demo name="shell/Nav Bar — Inline + Back, title outgrows the bar">
            <NavBarInline
              title="Field-level vector clocks and the delete-vs-edit tombstone"
              back={{ label: 'Architecture', onPress: noop }}
              actions={[{ icon: 'more', label: 'Note actions', onPress: noop }]}
            />
          </Demo>
        </Section>

        <Section title="Tab bar">
          <Demo name="Nav/TabBar">
            <TabBar
              items={tabs.map((item) => ({
                ...item,
                focused: item.key === tab,
                onPress: () => setTab(item.key),
                onLongPress: noop
              }))}
            />
          </Demo>
        </Section>

        <Section title="Buttons">
          <Demo name="Button/Primary">
            <Button label="Create note" onPress={noop} />
          </Demo>
          <Demo name="Button/Tint">
            <Button label="Sync now" variant="tint" onPress={noop} />
          </Demo>
          <Demo name="Button/Secondary">
            <Button label="Cancel" variant="secondary" onPress={noop} />
          </Demo>
          <Demo name="Button/Destructive">
            <Button label="Delete vault" variant="destructive" onPress={noop} />
          </Demo>
          <Demo name="Button/Ghost">
            <Button label="Skip for now" variant="ghost" onPress={noop} />
          </Demo>
        </Section>

        <Section title="Fields">
          <Demo name="Field/Default">
            <TextField placeholder="Note title" />
          </Demo>
          <Demo name="Field/Filled">
            <TextField value={filled} onChangeText={setFilled} />
          </Demo>
          <Demo name="Field/Focused (focus it to see the state)">
            <TextField placeholder="Tap here" />
          </Demo>
          <Demo name="Field/Error">
            <TextField value={invalid} onChangeText={setInvalid} error="Title is too short" />
          </Demo>
          <Demo name="Field/Search">
            <SearchField placeholder="Search notes" />
          </Demo>
        </Section>

        <Section title="Segmented control">
          <Demo name="Control/Segmented">
            <SegmentedControl
              segments={segments}
              value={segment}
              onChange={setSegment}
              accessibilityLabel="Gallery segments"
            />
          </Demo>
        </Section>

        <Section title="Sheet">
          <Demo name="Sheet/Handle">
            <SheetHandle />
          </Demo>
          <Demo name="Sheet/Bottom">
            <Button label="Open bottom sheet" onPress={() => setSheetOpen(true)} />
          </Demo>
        </Section>

        <Section title="Rows">
          <Demo name="Row/Plain (pressable)">
            <ListRow title="All notes" onPress={noop} />
          </Demo>
          <Demo name="Row/Note (pressable)">
            <ListRow
              title="Quarterly planning"
              subtitle="Edited 2 hours ago"
              variant="note"
              onPress={noop}
            />
          </Demo>
          <Demo name="Row/Folder (not pressable)">
            <ListRow title="Archive" subtitle="18 notes" variant="folder" />
          </Demo>
          <Demo name="Row/Setting (pressable)">
            <ListRow title="Sync and backup" variant="setting" onPress={noop} />
          </Demo>
        </Section>

        <Section title="Section header">
          <Demo name="Header/Section (with count)">
            <SectionHeader label="PINNED" count={4} />
          </Demo>
          <Demo name="Header/Section (no count)">
            <SectionHeader label="RECENT" />
          </Demo>
        </Section>

        <Section title="Tree row">
          <Demo name="Tree/Folder (expanded, emoji icon, live toggle)">
            <TreeRow
              label="Research"
              level={0}
              folder={{ expanded: researchExpanded }}
              icon={{ kind: 'emoji', text: '📚' }}
              onPress={noop}
              onToggle={() => setResearchExpanded((expanded) => !expanded)}
            />
          </Demo>
          <Demo name="Tree/Folder (collapsed, plain glyph, recursive count)">
            <TreeRow
              label="Archive"
              level={0}
              folder={{ expanded: false }}
              count={18}
              onPress={noop}
            />
          </Demo>
          <Demo name="Tree/Note (one row per file-type tone)">
            {noteFileTypes.map((fileType) => (
              <TreeRow
                key={fileType}
                label={`${fileType} — ${NOTE_FILE_TYPE_TONE[fileType]}`}
                level={1}
                tone={NOTE_FILE_TYPE_TONE[fileType]}
                onPress={noop}
              />
            ))}
          </Demo>
          <Demo name="Tree/Note (level 2, one indent step deeper)">
            <TreeRow label="Vector clocks" level={2} onPress={noop} />
          </Demo>
          <Demo name="Tree/Section header">
            <TreeSectionHeader label="FOLDERS" />
            <TreeSectionHeader label="NOTES — 24" style={styles.treeHeaderGap} />
          </Demo>
          <Demo name="Tree/Folder (count and a navigable chevron)">
            <TreeRow
              label="Meeting notes"
              level={0}
              folder={{ expanded: false }}
              count={7}
              chevron
              onPress={noop}
            />
          </Demo>
          <Demo name="Tree/Folder (selected, and the current location)">
            <TreeRow label="Inbox" level={0} folder={{ expanded: false }} selected onPress={noop} />
            <TreeRow
              label="Research"
              level={1}
              folder={{ expanded: false }}
              trailingLabel="current"
              onPress={noop}
            />
          </Demo>
        </Section>

        <Section title="Chips">
          <Demo name="Chip/Tag, Chip/Active, Chip/Tint">
            <View style={styles.chipRow}>
              <Chip label="research" />
              <Chip label="today" variant="active" />
              <Chip label="synced" variant="tint" />
            </View>
          </Demo>
        </Section>

        <Section title="Banners">
          <Demo name="Banner/ReadOnly, Banner/Offline, Banner/Update">
            <View style={styles.bannerStack}>
              <Banner
                variant="read-only"
                title="Read-only vault"
                body="Your plan has expired, so edits are paused until you renew."
              />
              <Banner
                variant="offline"
                title="Offline"
                body="Changes are saved on this device and will sync when you reconnect."
              />
              <Banner
                variant="update"
                title="Update available"
                body="A newer version of Memry is ready to install."
              />
            </View>
          </Demo>
        </Section>

        <Section title="Toast">
          <Demo name="Toast/Short">
            <Toast message="Note saved" />
          </Demo>
          <Demo name="Toast/Long">
            <Toast message="Note saved to Archive and synced across all of your devices" />
          </Demo>
          <Demo name="Toast/Action">
            <Toast
              message="Note duplicated"
              icon={null}
              action={{ label: 'Open', onPress: noop }}
            />
          </Demo>
        </Section>

        <Section title="Context menu">
          <Demo name="ContextMenu/Folder">
            <Button label="Open folder menu" onPress={() => setMenuKind('folder')} />
          </Demo>
          <Demo name="ContextMenu/Note">
            <Button label="Open note menu" onPress={() => setMenuKind('note')} />
          </Demo>
          <Demo name="PromptDialog">
            <Button label="Open new-folder dialog" onPress={() => setPromptOpen(true)} />
          </Demo>
        </Section>

        <Section title="FAB">
          <Demo name="FAB/Default">
            <FAB onPress={noop} accessibilityLabel="Create note" />
          </Demo>
        </Section>

        <Section title="Empty state">
          <Demo name="EmptyState/Default">
            <EmptyState
              title="No notes yet"
              body="Everything you write lands here. Start with a thought and shape it later."
              icon="note"
            />
          </Demo>
        </Section>

        <Section title="Skeleton row">
          <Demo name="Skeleton/Row">
            <View style={styles.skeletonStack}>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </View>
          </Demo>
        </Section>

        <Section title="Sync progress">
          <Demo name="Sync/Progress (25%)">
            <SyncProgress label="Syncing notes" detail="25 of 100" progress={0.25} />
          </Demo>
          <Demo name="Sync/Progress (65%)">
            <SyncProgress label="Uploading attachments" detail="162 of 250" progress={0.648} />
          </Demo>
        </Section>
      </ScrollView>

      <ContextMenu
        visible={menuKind !== null}
        anchorY={260}
        preview={
          menuKind === 'note' ? (
            <TreeRow label="Sync protocol — open questions" level={0} />
          ) : (
            <TreeRow label="Interviews" level={0} folder={{ expanded: false }} count={14} />
          )
        }
        groups={rowActionGroups(
          menuKind === 'note'
            ? { kind: 'note', id: 'n1', title: 'Sync protocol', folderPath: '' }
            : { kind: 'folder', path: 'Interviews', name: 'Interviews', noteCount: 14 },
          { bookmarked: false, readOnly: false }
        )}
        onSelect={() => setMenuKind(null)}
        onClose={() => setMenuKind(null)}
      />

      <PromptDialog
        visible={promptOpen}
        title="New folder"
        message="Created inside Interviews"
        initialValue="Untitled folder"
        confirmLabel="Create"
        onCancel={() => setPromptOpen(false)}
        onConfirm={() => setPromptOpen(false)}
      />

      <BottomSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        accessibilityLabel="Gallery bottom sheet"
      >
        <View style={styles.sheetBody}>
          <AppText variant="title3">Move note</AppText>
          <AppText variant="subhead" color={c.text.secondary}>
            Pick a folder for this note. The sheet is a plain modal, so it dismisses on the scrim,
            the close button, and the Android back gesture.
          </AppText>
          <Button label="Close" variant="secondary" onPress={() => setSheetOpen(false)} />
        </View>
      </BottomSheet>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: sizes.gutter, gap: space.s32 },
  section: { gap: space.s16 },
  demo: { gap: space.s8 },
  rampRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: space.s8 },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s16 },
  iconCell: { width: 84, alignItems: 'center', gap: space.s4 },
  iconLabel: { textAlign: 'center' },
  treeHeaderGap: { marginTop: space.s4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 },
  bannerStack: { gap: space.s12 },
  skeletonStack: { gap: space.s8 },
  sheetBody: {
    padding: sizes.gutter,
    paddingBottom: sizes.homeIndicator,
    gap: space.s12
  }
})
