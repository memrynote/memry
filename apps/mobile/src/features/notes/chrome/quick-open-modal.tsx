import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItemInfo
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import type { VaultDb } from '@/db/index'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import { createQuickNoteRepo, type QuickNote } from './quick-note-repo'

const QUERY_DEBOUNCE_MS = 180

type QueryState =
  | { kind: 'loading'; query: string }
  | { kind: 'ready'; query: string; notes: QuickNote[] }
  | { kind: 'failed'; query: string }

export interface QuickOpenModalProps {
  visible: boolean
  db: VaultDb
  currentNote: { title: string; excerpt?: string }
  canCreate: boolean
  onClose: () => void
  onOpen: (note: QuickNote) => void
  /** The route owns creation and navigation; this surface only chooses a title. */
  onCreate: (title: string) => void
}

export function QuickOpenModal(props: QuickOpenModalProps) {
  if (!props.visible) return null
  return (
    <Modal transparent visible animationType="fade" onRequestClose={props.onClose}>
      <SafeAreaProvider>
        <QuickOpenBody {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

function QuickOpenBody({
  db,
  currentNote,
  canCreate,
  onClose,
  onOpen,
  onCreate
}: QuickOpenModalProps) {
  const c = useColors()
  const repo = useMemo(() => createQuickNoteRepo(db), [db])
  const [query, setQuery] = useState('')
  const [state, setState] = useState<QueryState>({ kind: 'loading', query: '' })
  const generation = useRef(0)
  const trimmed = query.trim()
  const typed = trimmed.length > 0
  const matchingState = state.query === trimmed ? state : null
  const notes = matchingState?.kind === 'ready' ? matchingState.notes : []

  useEffect(() => {
    const currentGeneration = ++generation.current
    const timer = setTimeout(
      () => {
        void repo.search(trimmed).then(
          (next) => {
            if (generation.current === currentGeneration) {
              setState({ kind: 'ready', query: trimmed, notes: next })
            }
          },
          () => {
            if (generation.current === currentGeneration) {
              setState({ kind: 'failed', query: trimmed })
            }
          }
        )
      },
      typed ? QUERY_DEBOUNCE_MS : 0
    )
    return () => {
      clearTimeout(timer)
      generation.current += 1
    }
  }, [repo, trimmed, typed])

  const createTitle = typed ? trimmed : 'Untitled'
  const createLabel = typed ? `Create “${trimmed}”` : 'Create a new note'

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.fill}
    >
      <SafeAreaView
        edges={['top', 'left', 'right', 'bottom']}
        style={[styles.fill, { backgroundColor: c.canvas.background }]}
      >
        {/* Keep the existing note nav visible behind the transparent modal. */}
        <View style={styles.navWindow} pointerEvents="none" />

        <View style={[styles.body, { backgroundColor: c.canvas.background }]}>
          <View style={styles.currentContext} pointerEvents="none">
            <AppText variant="noteTitle" numberOfLines={1} color={c.text.secondary}>
              {currentNote.title}
            </AppText>
            {currentNote.excerpt ? (
              <AppText variant="body" numberOfLines={2} color={c.text.secondary}>
                {currentNote.excerpt}
              </AppText>
            ) : null}
          </View>

          <View style={[styles.results, { backgroundColor: c.canvas.surface }]}>
            <AppText variant="caption" color={c.text.secondary} style={styles.resultsHeader}>
              {typed
                ? matchingState?.kind === 'ready'
                  ? `Vault · ${notes.length} results`
                  : 'Vault'
                : 'Recent in this vault'}
            </AppText>
            <FlatList
              data={notes}
              keyExtractor={(note) => note.id}
              keyboardShouldPersistTaps="handled"
              renderItem={(info) => <QuickNoteRow info={info} onOpen={onOpen} />}
              ListEmptyComponent={
                matchingState?.kind === 'failed' ? (
                  <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
                    Notes could not be loaded.
                  </AppText>
                ) : matchingState?.kind === 'ready' ? (
                  <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
                    {typed ? 'No notes match that title.' : 'No recent notes yet.'}
                  </AppText>
                ) : null
              }
              ListFooterComponent={
                canCreate ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={createLabel}
                    onPress={() => onCreate(createTitle)}
                    style={({ pressed }) => [
                      styles.resultRow,
                      { borderTopColor: c.line.border },
                      pressed && { backgroundColor: c.canvas.surfaceActive }
                    ]}
                  >
                    <View style={styles.resultIcon}>
                      <Icon name="plus" size={20} color={c.text.tertiary} />
                    </View>
                    <AppText variant="subhead" color={c.text.primary} numberOfLines={1}>
                      {createLabel}
                    </AppText>
                  </Pressable>
                ) : null
              }
            />
          </View>
        </View>

        <View
          style={[
            styles.searchBar,
            {
              backgroundColor: c.canvas.background,
              borderTopColor: c.line.border
            }
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={createLabel}
            accessibilityState={{ disabled: !canCreate }}
            disabled={!canCreate}
            onPress={() => onCreate(createTitle)}
            style={({ pressed }) => [
              styles.squareButton,
              { backgroundColor: c.canvas.surfaceActive, opacity: canCreate ? 1 : 0.45 },
              pressed && { opacity: 0.7 }
            ]}
          >
            <Icon name="plus" size={22} color={c.text.primary} strokeWidth={1.8} />
          </Pressable>

          <View
            accessibilityRole="search"
            style={[
              styles.queryField,
              { backgroundColor: c.canvas.surface, borderColor: c.line.border }
            ]}
          >
            <Icon name="search" size={18} color={c.text.tertiary} strokeWidth={1.8} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Find or create a note…"
              placeholderTextColor={c.text.secondary}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={[styles.queryInput, textStyles.callout, { color: c.text.primary }]}
            />
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close find or create"
            onPress={onClose}
            style={styles.squareButton}
          >
            <Icon name="close" size={21} color={c.text.primary} strokeWidth={1.8} />
          </Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  )
}

function QuickNoteRow({
  info,
  onOpen
}: {
  info: ListRenderItemInfo<QuickNote>
  onOpen: (note: QuickNote) => void
}) {
  const c = useColors()
  const note = info.item
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open note ${note.title}`}
      onPress={() => onOpen(note)}
      style={({ pressed }) => [
        styles.resultRow,
        { borderTopColor: c.line.border },
        pressed && { backgroundColor: c.canvas.surfaceActive }
      ]}
    >
      <View style={styles.resultIcon}>
        <Icon name="file" size={20} color={c.text.tertiary} />
      </View>
      <View style={styles.resultText}>
        <AppText variant="subhead" color={c.text.primary} numberOfLines={1}>
          {note.title}
        </AppText>
        <AppText variant="caption" color={c.text.secondary} numberOfLines={1}>
          {note.folderPath || 'Note'}
        </AppText>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  navWindow: { height: sizes.navBar },
  body: { flex: 1, minHeight: 0 },
  currentContext: {
    height: 132,
    paddingStart: space.s20,
    paddingEnd: space.s20,
    paddingTop: space.s16,
    gap: space.s12,
    opacity: 0.52
  },
  results: { flex: 1, minHeight: 0 },
  resultsHeader: {
    height: 28,
    paddingStart: space.s16,
    paddingEnd: space.s16,
    textAlignVertical: 'center'
  },
  resultRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12,
    paddingStart: space.s16,
    paddingEnd: space.s16,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  resultIcon: {
    width: 24,
    height: 24,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  resultText: { flex: 1, minWidth: 0, gap: space.s2 },
  empty: { paddingStart: space.s16, paddingEnd: space.s16, paddingVertical: space.s16 },
  searchBar: {
    height: sizes.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingStart: space.s12,
    paddingEnd: space.s12,
    paddingVertical: space.s6,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  squareButton: {
    width: sizes.tapTarget,
    height: sizes.tapTarget,
    flexShrink: 0,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  queryField: {
    flex: 1,
    minWidth: 0,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    paddingStart: space.s8,
    paddingEnd: space.s8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10
  },
  queryInput: { flex: 1, minWidth: 0, padding: 0 }
})
