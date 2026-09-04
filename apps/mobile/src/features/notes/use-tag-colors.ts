import { useEffect, useState } from 'react'

import type { VaultDb } from '@/db/index'
import { tagColor, type TagColor } from '@/theme/colors/tag-colors'
import { normalizeTagKey } from './note-ops'
import { readTagColors } from './tag-definitions'

/**
 * A resolver from tag name to chip colours, backed by the vault's synced
 * `tag_definition` rows.
 *
 * Read once per mount rather than subscribed: a colour that changes on another
 * device lands on the next open of this screen. The alternative is a watcher on
 * a table this screen never writes, for a change that happens about as often as
 * a user renames a tag.
 *
 * Before the rows load — and forever, on a vault where nobody picked colours —
 * the resolver falls back to the shared hash, which is the colour desktop shows
 * for that same tag. So there is no flash of "wrong" colour, only of "unpicked".
 */
export function useTagColors(db: VaultDb | null): (tag: string) => TagColor {
  const [authored, setAuthored] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    if (!db) return
    let live = true
    void readTagColors(db).then((colors) => {
      if (live) setAuthored(colors)
    })
    return () => {
      live = false
    }
  }, [db])

  return (tag: string) => tagColor(tag, authored.get(normalizeTagKey(tag)))
}
