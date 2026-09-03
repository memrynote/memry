import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { SearchField } from '@/components/ui/search-field'
import { openVaultDb, type VaultDb } from '@/db/index'
import { folderName } from '@/features/notes/folder-ops'
import { searchInFolder, type FolderSearchHit } from '@/features/notes/folder-search'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * Search inside one folder (board 26H), reached from the folder row's long
 * press as `/notes/search?path=<encoded>`.
 *
 * The scope is a CHIP rather than a mode: removing it is how you widen the
 * search to the whole vault, which is the one thing a scoped search always
 * needs an escape from. Tapping it lands on the global search screen with the
 * query intact.
 */
export default function NotesFolderSearchScreen() {
  const c = useColors()
  const { path: pathParam } = useLocalSearchParams<{ path?: string }>()
  const path = pathParam ?? ''

  const [db, setDb] = useState<VaultDb | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FolderSearchHit[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    void (async () => {
      const vaultId = await loadCurrentVaultId()
      if (vaultId) setDb(await openVaultDb(vaultId))
    })()
  }, [])

  useEffect(() => {
    if (!db) return
    let cancelled = false
    void searchInFolder(db, path, query).then((result) => {
      // A keystroke that arrives while an earlier query is in flight must not
      // be overwritten by that query's slower answer.
      if (cancelled) return
      setHits(result.hits)
      setTotal(result.total)
    })
    return () => {
      cancelled = true
    }
  }, [db, path, query])

  const widen = useCallback(() => {
    router.back()
  }, [])

  const name = folderName(path) || 'Vault'
  const typed = query.trim().length > 0

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
    >
      <View style={styles.searchRow}>
        <SearchField
          style={styles.searchField}
          placeholder={`Search ${name}`}
          autoFocus
          returnKeyType="search"
          clearButtonMode="while-editing"
          value={query}
          onChangeText={setQuery}
        />
        <Pressable accessibilityRole="button" hitSlop={space.s12} onPress={() => router.back()}>
          <AppText color={c.tint.text}>Cancel</AppText>
        </Pressable>
      </View>

      <View style={styles.scopeRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove the ${name} scope`}
          // The chip draws at 28pt, so the slop is what carries it to the 44pt
          // minimum without changing the row's geometry.
          hitSlop={{ top: space.s8, bottom: space.s8 }}
          onPress={widen}
          style={[styles.chip, { backgroundColor: c.ui.primary }]}
        >
          <AppText variant="caption" color={c.ui.primaryForeground}>
            {`In ${name}`}
          </AppText>
          <Icon name="close" size={12} color={c.ui.primaryForeground} />
        </Pressable>
        <View style={styles.countLane}>
          <AppText variant="caption" color={c.text.tertiary}>
            {typed ? `${hits.length} of ${total} notes` : `${total} notes`}
          </AppText>
        </View>
      </View>

      <FlatList
        data={hits}
        keyExtractor={(hit) => hit.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open note ${item.title}`}
            onPress={() => router.push(`/notes/${item.id}`)}
            style={({ pressed }) => [
              styles.hit,
              { borderBottomColor: c.line.border },
              pressed && { backgroundColor: c.canvas.surface }
            ]}
          >
            <AppText variant="subheadEmphasis" numberOfLines={1}>
              {item.title}
            </AppText>
            {item.snippet ? (
              <AppText variant="footnote" color={c.text.secondary} numberOfLines={1}>
                {item.snippet}
              </AppText>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
            {typed ? `Nothing in ${name} matches that.` : `Type to search inside ${name}.`}
          </AppText>
        }
      />

      <AppText variant="footnote" color={c.text.tertiary} style={styles.footnote}>
        Remove the scope chip to search the whole vault.
      </AppText>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  searchRow: {
    height: 52,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12
  },
  searchField: { flex: 1 },
  scopeRow: {
    height: 44,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8
  },
  chip: {
    height: 28,
    paddingStart: space.s12,
    paddingEnd: space.s8,
    borderRadius: radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6
  },
  countLane: { flex: 1, alignItems: 'flex-end' },
  hit: {
    minHeight: 72,
    justifyContent: 'center',
    gap: space.s2,
    paddingHorizontal: sizes.gutter,
    paddingVertical: space.s12,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  empty: { paddingHorizontal: sizes.gutter, paddingTop: space.s12 },
  footnote: { paddingHorizontal: space.s24, paddingBottom: space.s12, textAlign: 'center' }
})
