import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { EmptyState } from '@/components/ui/empty-state'
import { NavBarInline } from '@/components/ui/nav-bar'
import { openVaultDb } from '@/db/index'
import { readBacklinks, type Backlink, type BacklinksResult } from '@/features/notes/backlinks'
import { useWorkspaceTabs } from '@/features/workspace-tabs/provider'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('BacklinksScreen')

const WIKILINK_RE = /\[\[[^\]]*\]\]/g

const EMPTY: BacklinksResult = { backlinks: [], totalReferences: 0, missingBodies: 0 }

/**
 * Which notes link to this one, reached as `/notes/backlinks?id=<noteId>`.
 *
 * Desktop shows this as a section under the editor; mobile has no room beside
 * the body, so the note's More sheet pushes it as its own screen. A STATIC
 * route beside the dynamic `[id].tsx`, like `tag.tsx` and `folder.tsx`.
 */
export default function BacklinksScreen() {
  const c = useColors()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const noteId = id ?? ''
  const { open } = useWorkspaceTabs()

  const [result, setResult] = useState<BacklinksResult>(EMPTY)

  const reload = useCallback(async () => {
    if (!noteId) return
    const vaultId = await loadCurrentVaultId()
    if (!vaultId) return
    try {
      const db = await openVaultDb(vaultId)
      setResult(await readBacklinks(db, noteId))
    } catch (error) {
      log.error('Loading backlinks failed', { error: String(error) })
    }
  }, [noteId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload])
  )

  const openSource = (backlink: Backlink): void => {
    open({ id: backlink.sourceId, title: backlink.sourceTitle })
  }

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
    >
      <View style={[styles.navBorder, { borderBottomColor: c.line.border }]}>
        <NavBarInline
          title="Backlinks"
          back={{ label: 'Back', onPress: () => router.back(), showLabel: false }}
        />
      </View>

      {result.backlinks.length > 0 ? (
        <AppText variant="footnote" color={c.text.secondary} style={styles.summary}>
          {result.backlinks.length} notes · {result.totalReferences} references
        </AppText>
      ) : null}

      <FlatList
        data={result.backlinks}
        keyExtractor={(backlink) => backlink.sourceId}
        renderItem={({ item }) => (
          <View style={styles.group}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open note ${item.sourceTitle}`}
              onPress={() => openSource(item)}
              style={({ pressed }) => [
                styles.header,
                pressed && { backgroundColor: c.canvas.surface }
              ]}
            >
              <AppText variant="headline" numberOfLines={1}>
                {item.sourceTitle}
              </AppText>
              {item.folderPath ? (
                <AppText variant="caption" color={c.text.secondary} numberOfLines={1}>
                  {item.folderPath}
                </AppText>
              ) : null}
            </Pressable>

            {item.mentions.map((mention) => (
              <Pressable
                key={`${mention.line}-${mention.linkStart}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.sourceTitle} at line ${mention.line}`}
                onPress={() => openSource(item)}
                style={({ pressed }) => [
                  styles.mention,
                  pressed && { backgroundColor: c.canvas.surface }
                ]}
              >
                <AppText variant="caption" color={c.text.tertiary}>
                  Line {mention.line}
                </AppText>
                <AppText variant="footnote" numberOfLines={3}>
                  {snippetParts(mention.snippet).map((part, index) => (
                    <AppText
                      key={index}
                      variant="footnote"
                      color={part.link ? c.text.tertiary : c.text.primary}
                    >
                      {part.text}
                    </AppText>
                  ))}
                </AppText>
              </Pressable>
            ))}
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            icon="link"
            title="No backlinks"
            body="No other note links to this one yet."
            style={styles.empty}
          />
        }
        ListFooterComponent={
          result.missingBodies > 0 ? (
            <AppText variant="caption" color={c.text.tertiary} style={styles.caption}>
              {result.missingBodies} notes haven&apos;t been downloaded yet, so their links
              aren&apos;t counted.
            </AppText>
          ) : null
        }
      />
    </SafeAreaView>
  )
}

interface SnippetPart {
  text: string
  link: boolean
}

/** The `[[...]]` runs keep their brackets and recede, exactly as on desktop. */
function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let last = 0
  for (const match of snippet.matchAll(WIKILINK_RE)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: snippet.slice(last, index), link: false })
    parts.push({ text: match[0], link: true })
    last = index + match[0].length
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), link: false })
  return parts.length > 0 ? parts : [{ text: snippet, link: false }]
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  navBorder: { borderBottomWidth: 1 },
  summary: { paddingHorizontal: space.s16, paddingTop: space.s12 },
  group: { paddingTop: space.s16 },
  header: { gap: space.s2, paddingHorizontal: space.s16, paddingVertical: space.s8 },
  mention: {
    gap: space.s4,
    paddingVertical: space.s8,
    paddingStart: space.s32,
    paddingEnd: space.s16
  },
  empty: { paddingTop: space.s48 },
  caption: { paddingHorizontal: space.s16, paddingVertical: space.s16 }
})
