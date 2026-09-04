import { describe, expect, it } from 'vitest'

import { createMobileEditorSchema } from '../../editor-web/src/schema'

/**
 * The block-coverage gate (#2027, epic #2025).
 *
 * Mobile registers the SAME schema as desktop, because a node type the schema
 * cannot build is deleted from the shared Y.Doc by y-prosemirror — a missing
 * spec replicates as data loss, not as a rendering gap. So nothing here may
 * ever be fixed by dropping a spec. Registration is complete and stays
 * complete; the open question is only whether what gets registered PRESENTS
 * anything on a touch surface.
 *
 * It mostly does not. `createServerBlockSpecs()` and `createServerInlineSpecs()`
 * are the main process's SERIALIZATION DOM: the shapes chosen for what
 * BlockNote's HTML→markdown step turns them into, verified byte-for-byte
 * against the marker each block already has on disk. A file block is an HTML
 * comment, so it is invisible. A callout is a blockquote whose first line is a
 * literal `[!info]`. A task block is an inert checkbox trailing a raw
 * `{task:id}`. Bookmarks and YouTube embeds are `<img src=https://…>` that the
 * WebView's CSP blocks. Correct on disk, unusable on a phone.
 *
 * This file is the structural guard against that set ever growing silently. It
 * enumerates the built schema and partitions every key against the two lists
 * below. A key in NEITHER list fails — which is the whole point, because that
 * is what a future BlockNote default block or a new Memry spec looks like on
 * the day it ships unrendered on mobile.
 *
 * ## How to work on this file
 *
 * Keys move from `KNOWN_UNRENDERED_*` to `TOUCH_RENDERED_*` and never the other
 * way. You move one when you land its renderer, in the same commit, and the
 * pinned count below drops with it. That is the only edit this file expects.
 *
 * Adding a key to `KNOWN_UNRENDERED_*` is the opposite act: it asks a reviewer
 * to accept shipping something a user cannot see. The pinned count makes that
 * impossible to do quietly. It is the same rule as the desktop typecheck
 * exclude backlog — a list that only ever shrinks.
 *
 * ## Where the line is drawn
 *
 * A key is TOUCH_RENDERED when its spec in the mobile schema is a presentation
 * implementation: BlockNote's own default block or inline spec, whose DOM is
 * what `editor-web/src/styles.css` is written against, or a Memry spec
 * deliberately re-flavoured for touch. Exactly one is re-flavoured today,
 * `wikiLink`, whose editor DOM carries the `data-target` the tap handler in
 * `wiki-links.ts` reads.
 *
 * A key is KNOWN_UNRENDERED when its spec comes from `createServerBlockSpecs()`
 * or `createServerInlineSpecs()`. That is a mechanical line, not a judgement
 * call, so it does not drift as people disagree about how bad a given block
 * looks.
 *
 * `image`, `video` and `audio` are called rendered on the strength of their
 * BlockNote DOM, and their vault-relative `src` is resolved separately by the
 * DOM-level resolver in `editor-web/src/images.ts`. `table` is rendered by the
 * same rule and is what #2041 audits; if that audit finds it broken on touch,
 * moving it here is exactly the deliberate, reviewed act the pinned count is
 * for.
 */

/** Block keys whose spec in the mobile schema actually presents something. */
const TOUCH_RENDERED_BLOCKS = [
  'audio',
  'bulletListItem',
  'checkListItem',
  'codeBlock',
  'divider',
  'heading',
  'image',
  'numberedListItem',
  'paragraph',
  'quote',
  'table',
  'video'
]

/** Inline keys whose spec in the mobile schema actually presents something. */
const TOUCH_RENDERED_INLINE = ['link', 'text', 'wikiLink']

/**
 * Block keys still falling through to the main process's serialization DOM.
 *
 * Renderers are tracked as #2035 (file), #2036 (callout), #2037 (taskBlock),
 * #2038 (toggleListItem) and #2039 (bookmark, youtubeEmbed).
 */
const KNOWN_UNRENDERED_BLOCKS = [
  'bookmark',
  'callout',
  'file',
  'taskBlock',
  'toggleListItem',
  'youtubeEmbed'
]

/**
 * Inline keys still falling through to the main process's serialization DOM.
 * Renderers are tracked as #2040.
 */
const KNOWN_UNRENDERED_INLINE = [
  'dateMention',
  'hashTag',
  'inlineCheckbox',
  'inlineImage',
  'linkMention'
]

/**
 * The size of the backlog, pinned.
 *
 * Editing a list above is already visible in the diff, but a reviewer skimming
 * a large mobile PR can miss one line in it. Landing a renderer has to drop
 * this number too, and adding a key has to raise it, so the backlog cannot
 * change without a second, deliberate edit that says which direction it moved.
 */
const KNOWN_UNRENDERED_COUNT = 11

const schema = createMobileEditorSchema()

function assertPartition(
  half: string,
  schemaKeys: string[],
  rendered: string[],
  backlog: string[]
): void {
  const renderedSet = new Set(rendered)
  const backlogSet = new Set(backlog)

  const unclassified = schemaKeys.filter((key) => !renderedSet.has(key) && !backlogSet.has(key))
  expect(
    unclassified,
    `${half} keys with no mobile renderer and no entry in KNOWN_UNRENDERED. ` +
      'Land a touch renderer and list the key in the rendered set, or add it to the backlog ' +
      'and raise KNOWN_UNRENDERED_COUNT so a reviewer sees that mobile ships it invisible.'
  ).toEqual([])

  const claimedTwice = schemaKeys.filter((key) => renderedSet.has(key) && backlogSet.has(key))
  expect(
    claimedTwice,
    `${half} keys listed as both rendered and unrendered. A key moves out of the backlog when ` +
      'its renderer lands; it is never in both.'
  ).toEqual([])
}

describe('the mobile editor schema', () => {
  it('classifies every block key as rendered or known-unrendered', () => {
    assertPartition(
      'Block',
      Object.keys(schema.blockSchema),
      TOUCH_RENDERED_BLOCKS,
      KNOWN_UNRENDERED_BLOCKS
    )
  })

  it('classifies every inline content key as rendered or known-unrendered', () => {
    assertPartition(
      'Inline content',
      Object.keys(schema.inlineContentSchema),
      TOUCH_RENDERED_INLINE,
      KNOWN_UNRENDERED_INLINE
    )
  })

  it('holds no backlog or rendered key the schema no longer has', () => {
    // Without this the lists rot silently: a renamed spec leaves a dead entry
    // behind, and a dead entry in the backlog is a renderer nobody will ever
    // be asked to write.
    const blockKeys = new Set(Object.keys(schema.blockSchema))
    const inlineKeys = new Set(Object.keys(schema.inlineContentSchema))

    expect(
      [...KNOWN_UNRENDERED_BLOCKS, ...TOUCH_RENDERED_BLOCKS].filter((k) => !blockKeys.has(k))
    ).toEqual([])
    expect(
      [...KNOWN_UNRENDERED_INLINE, ...TOUCH_RENDERED_INLINE].filter((k) => !inlineKeys.has(k))
    ).toEqual([])
  })

  it('keeps the backlog at its pinned size, sorted and free of duplicates', () => {
    const backlog = [...KNOWN_UNRENDERED_BLOCKS, ...KNOWN_UNRENDERED_INLINE]

    expect(
      backlog.length,
      'KNOWN_UNRENDERED changed size. Landing a renderer lowers KNOWN_UNRENDERED_COUNT; ' +
        'raising it means mobile is shipping another block a user cannot see.'
    ).toBe(KNOWN_UNRENDERED_COUNT)
    expect(new Set(backlog).size, 'duplicate key in KNOWN_UNRENDERED').toBe(backlog.length)
    // Sorted, so a key cannot be hidden mid-list where a diff reads as noise.
    expect(KNOWN_UNRENDERED_BLOCKS).toEqual([...KNOWN_UNRENDERED_BLOCKS].sort())
    expect(KNOWN_UNRENDERED_INLINE).toEqual([...KNOWN_UNRENDERED_INLINE].sort())
  })

  /**
   * The parity target. The four checks above keep the backlog honest; this one
   * is the goal they are keeping honest FOR. It names exactly what is left, so
   * nobody has to read an epic to find out how far mobile block parity has got.
   *
   * `it.fails` carries the same contract `conformance.ts` uses for a case whose
   * fix ships in a sibling issue: the inverted expectation turns RED the moment
   * the backlog empties, which forces the flag off rather than letting a passing
   * assertion sit here disguised as a failing one. Remove the flag, never the
   * case (#2041).
   *
   * The alternative was leaving mobile CI red for the length of the epic, which
   * would have cost every unit in between its regression signal.
   */
  it.fails('renders every block and inline type the schema can build', () => {
    expect(
      [...KNOWN_UNRENDERED_BLOCKS, ...KNOWN_UNRENDERED_INLINE],
      'these schema keys still render through the main process serialization DOM, so on mobile ' +
        'they are invisible or broken. Each one needs a touch renderer; see epic #2025.'
    ).toEqual([])
  })
})
