import { useEffect, useRef, useState } from 'react'
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
import type { WikiCandidate } from '@memry/contracts/webview-bridge'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import type { VaultDb } from '@/db/index'
import { queryWikiCandidates } from '@/editor/wiki-links'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

/**
 * Where a block goes (#2100).
 *
 * Built on `quick-open-modal.tsx`'s shell — same `Modal`, same debounce, same
 * generation ref — but it is a CHOOSER and not a launcher: there is no create
 * row, because a move into a note that does not exist yet needs a note
 * creation this surface does not own, and the note the block is in is dropped
 * from the rows because a block cannot move into itself.
 *
 * The rows come from `queryWikiCandidates`, the same search `[[` uses, so a
 * note is found here by exactly what finds it there.
 */

const QUERY_DEBOUNCE_MS = 180
const RESULT_LIMIT = 20

/**
 * How many rows to ASK for.
 *
 * `queryWikiCandidates` fills its limit before this surface drops the current
 * note and the non-note rows, so asking for exactly `RESULT_LIMIT` shows 19 of
 * 20 whenever the current note would have been in the list — which, for the
 * empty query (recently modified), is always.
 */
const QUERY_LIMIT = RESULT_LIMIT + 1

type QueryState =
  | { kind: 'loading'; query: string }
  | { kind: 'ready'; query: string; notes: WikiCandidate[] }
  | { kind: 'failed'; query: string }

export interface BlockMovePickerProps {
  db: VaultDb
  /** Excluded from the rows: a block cannot move into the note it is in. */
  currentNoteId: string
  /** The block's own label — the sheet reads "Move image to…". */
  blockLabel: string
  onCancel: () => void
  onPick: (target: { id: string; title: string }) => void
}

export function BlockMovePicker(props: BlockMovePickerProps) {
  return (
    <Modal transparent visible animationType="fade" onRequestClose={props.onCancel}>
      <SafeAreaProvider>
        <BlockMovePickerBody {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

function BlockMovePickerBody({
  db,
  currentNoteId,
  blockLabel,
  onCancel,
  onPick
}: BlockMovePickerProps) {
  const c = useColors()
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
        void queryWikiCandidates(db, trimmed, QUERY_LIMIT).then(
          (rows) => {
            if (generation.current !== currentGeneration) return
            setState({
              kind: 'ready',
              query: trimmed,
              // `create`, `alias` and `heading` rows all point at something
              // that is not a note this block can land in.
              notes: rows
                .filter((row) => row.kind === 'note' && row.id !== currentNoteId)
                .slice(0, RESULT_LIMIT)
            })
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
  }, [currentNoteId, db, trimmed, typed])

  const title = `Move ${blockLabel || 'block'} to…`

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.fill}
    >
      <SafeAreaView
        edges={['top', 'left', 'right', 'bottom']}
        style={[styles.fill, { backgroundColor: c.canvas.background }]}
      >
        <View style={[styles.header, { borderBottomColor: c.line.border }]}>
          <AppText variant="subhead" color={c.text.primary} numberOfLines={1} style={styles.title}>
            {title}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel move"
            onPress={onCancel}
            style={styles.squareButton}
          >
            <Icon name="close" size={21} color={c.text.primary} strokeWidth={1.8} />
          </Pressable>
        </View>

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
            placeholder="Find a note…"
            placeholderTextColor={c.text.secondary}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={[styles.queryInput, textStyles.callout, { color: c.text.primary }]}
          />
        </View>

        <View style={[styles.results, { backgroundColor: c.canvas.surface }]}>
          <AppText variant="caption" color={c.text.secondary} style={styles.resultsHeader}>
            {typed ? 'Vault' : 'Recent in this vault'}
          </AppText>
          <FlatList
            data={notes}
            keyExtractor={(note) => note.id}
            keyboardShouldPersistTaps="handled"
            renderItem={(info) => <TargetRow info={info} onPick={onPick} />}
            ListEmptyComponent={
              matchingState?.kind === 'failed' ? (
                <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
                  Notes could not be loaded.
                </AppText>
              ) : matchingState?.kind === 'ready' ? (
                <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
                  {typed ? 'No notes match that title.' : 'No other notes yet.'}
                </AppText>
              ) : null
            }
          />
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  )
}

function TargetRow({
  info,
  onPick
}: {
  info: ListRenderItemInfo<WikiCandidate>
  onPick: (target: { id: string; title: string }) => void
}) {
  const c = useColors()
  const note = info.item
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Move into ${note.title}`}
      onPress={() => onPick({ id: note.id, title: note.title })}
      style={({ pressed }) => [
        styles.resultRow,
        { borderTopColor: c.line.border },
        pressed && { backgroundColor: c.canvas.surfaceActive }
      ]}
    >
      <View style={styles.resultIcon}>
        {/* The note's own emoji when it has one; the WebView's icon set does
            not reach here, so a named icon falls back to the file glyph. */}
        {note.icon && !/^[A-Za-z0-9._-]+$/.test(note.icon) ? (
          <AppText variant="subhead" color={c.text.primary}>
            {note.icon}
          </AppText>
        ) : (
          <Icon name="file" size={20} color={c.text.tertiary} />
        )}
      </View>
      <View style={styles.resultText}>
        <AppText variant="subhead" color={c.text.primary} numberOfLines={1}>
          {note.title}
        </AppText>
        <AppText variant="caption" color={c.text.secondary} numberOfLines={1}>
          {note.subtitle || 'Note'}
        </AppText>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    height: sizes.navBar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingStart: space.s16,
    paddingEnd: space.s8,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  // No explicit alignment: the default follows the writing direction, which is
  // what an RTL vault needs.
  title: { flex: 1, minWidth: 0 },
  squareButton: {
    width: sizes.tapTarget,
    height: sizes.tapTarget,
    flexShrink: 0,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  queryField: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    marginStart: space.s12,
    marginEnd: space.s12,
    marginTop: space.s12,
    marginBottom: space.s12,
    paddingStart: space.s8,
    paddingEnd: space.s8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10
  },
  queryInput: { flex: 1, minWidth: 0, padding: 0 },
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
  empty: { paddingStart: space.s16, paddingEnd: space.s16, paddingVertical: space.s16 }
})
