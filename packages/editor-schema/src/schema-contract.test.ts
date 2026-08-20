/**
 * The schema-parity gate (#1433).
 *
 * The document schema is a cross-process contract like the IPC one, and it has
 * a worse failure mode: y-prosemirror answers a node name its schema cannot
 * build by DELETING the element from the shared Y.Doc, which then replicates to
 * every device. `pnpm ipc:check` gates the IPC contract; this file gates this one.
 *
 * A name-and-propSchema comparison is necessary and NOT sufficient. Every
 * release-blocking bug this epic found had matching names and matching
 * propSchemas — what diverged was the IMPLEMENTATION:
 *
 *   - the editor's rich `linkMention` render reached main, and BlockNote
 *     serializes inline content inside a TABLE through `render`, so
 *     `((mention:…))` was rewritten as `[x.com](https://x.com/y)` on disk
 *   - `wikiLink` / `hashTag` / `dateMention` / `taskBlock` had a `render` that
 *     threw, on the reasoning that a serialization-only schema never renders;
 *     in a table (or under a list item) that throw made `yDocToMarkdown` return
 *     null and the note stopped writing back entirely
 *
 * So this file asserts BEHAVIOUR: every server implementation emits exactly
 * what its own `toExternalHTML` emits, and none of them throws. The renderer
 * half of the comparison lives in the desktop renderer suite
 * (`apps/desktop/src/renderer/src/components/note/content-area/editor-schema.test.ts`)
 * because the renderer's specs are React and this package must stay portable;
 * the bytes each block reaches the vault as are gated in
 * `apps/desktop/src/main/sync/blocknote-converter.test.ts`, against the real
 * `yDocToMarkdown`.
 *
 * Every case list below is derived from the exported type lists, so a spec
 * added without a fixture FAILS rather than being silently untested. That is
 * the whole point: the bug class was one spec nobody covered.
 */

import { describe, expect, it } from 'vitest'
import { createMemrySchema } from './schema'
import {
  MEMRY_INLINE_CONTENT_TYPES,
  createMemryInlineContentSpecs,
  dateMentionConfig,
  hashTagConfig,
  inlineImageConfig,
  linkMentionConfig,
  wikiLinkConfig,
  type MemryInlineSpecs
} from './inline'
import {
  MEMRY_BLOCK_TYPES,
  bookmarkConfig,
  calloutConfig,
  fileBlockConfig,
  taskBlockConfig,
  youtubeEmbedConfig
} from './blocks'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

type MemryBlockType = (typeof MEMRY_BLOCK_TYPES)[number]
type MemryInlineType = (typeof MEMRY_INLINE_CONTENT_TYPES)[number]

/**
 * The config each spec's propSchema must come from. A `Record` keyed by the
 * exported union, so a new type with no entry is a compile error here as well
 * as a test failure.
 */
const BLOCK_CONFIGS: Record<MemryBlockType, { type: string; propSchema: object }> = {
  taskBlock: taskBlockConfig,
  callout: calloutConfig,
  file: fileBlockConfig,
  youtubeEmbed: youtubeEmbedConfig,
  bookmark: bookmarkConfig
}

const INLINE_CONFIGS: Record<MemryInlineType, { type: string; propSchema: object }> = {
  wikiLink: wikiLinkConfig,
  linkMention: linkMentionConfig,
  hashTag: hashTagConfig,
  dateMention: dateMentionConfig,
  inlineImage: inlineImageConfig
}

/** One block per custom type, as the renderer authors it. */
const BLOCK_FIXTURES: Record<MemryBlockType, unknown> = {
  taskBlock: {
    id: 'blk',
    type: 'taskBlock',
    props: { taskId: 't1', title: 'a task', checked: false, parentTaskId: '' },
    children: []
  },
  callout: {
    id: 'blk',
    type: 'callout',
    props: { type: 'info', textAlignment: 'left', textColor: 'default' },
    content: [{ type: 'text', text: 'Heads up', styles: {} }],
    children: []
  },
  file: {
    id: 'blk',
    type: 'file',
    props: {
      url: 'memry-file://local/v/a/x.pdf',
      name: 'x.pdf',
      size: 1234,
      mimeType: 'application/pdf',
      width: 0,
      height: 0,
      align: 'left'
    },
    children: []
  },
  youtubeEmbed: {
    id: 'blk',
    type: 'youtubeEmbed',
    props: { videoId: 'dQw4w9WgXcQ', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    children: []
  },
  bookmark: {
    id: 'blk',
    type: 'bookmark',
    props: {
      url: 'https://example.com/a',
      domain: 'example.com',
      title: 'T',
      description: 'D',
      image: 'https://example.com/i.png',
      favicon: 'https://example.com/f.ico',
      siteName: 'Example'
    },
    children: []
  }
}

/**
 * One inline node per custom type. Props are populated, not defaulted: the
 * `linkMention` bug was invisible with empty metadata — the rich `<a>` chip and
 * the token only diverge visibly once there is a domain/title/favicon to lose.
 */
const INLINE_FIXTURES: Record<MemryInlineType, unknown> = {
  wikiLink: { type: 'wikiLink', props: { target: 'Roadmap', alias: 'the plan' } },
  linkMention: {
    type: 'linkMention',
    props: {
      url: 'https://x.com/y',
      domain: 'x.com',
      title: 'A title',
      favicon: 'https://x.com/f.ico',
      siteName: 'X'
    }
  },
  hashTag: { type: 'hashTag', props: { tag: 'work', color: 'blue', icon: 'star' } },
  dateMention: {
    type: 'dateMention',
    props: {
      anchorId: 'a1',
      dateISO: '2026-08-14',
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system'
    }
  },
  inlineImage: {
    type: 'inlineImage',
    props: { src: '../attachments/n1/photo.png', alt: 'photo.png', width: 240 }
  }
}

/** The shape `createBlockSpec` / `createInlineContentSpec` return. */
interface AnySpec {
  config: { type: string; propSchema: object }
  implementation: {
    render: (node: unknown, editor: unknown) => { dom: HTMLElement }
    toExternalHTML?: (
      node: unknown,
      editor: unknown,
      context: { nestingLevel: number }
    ) => { dom: HTMLElement } | undefined
  }
}

function serverBlockSpecs(): Record<string, AnySpec> {
  return createServerBlockSpecs() as unknown as Record<string, AnySpec>
}

function serverInlineSpecs(): Record<string, AnySpec> {
  return createServerInlineSpecs() as unknown as Record<string, AnySpec>
}

function serverSchema() {
  return createMemrySchema({ blocks: createServerBlockSpecs(), inline: createServerInlineSpecs() })
}

const sorted = (values: readonly string[]): string[] => [...values].sort()

// ---------------------------------------------------------------------------
// Gate 1 — every custom spec is registered, on both halves of the package
// ---------------------------------------------------------------------------

describe('every declared node type has a spec, and every spec is declared', () => {
  it('the server block specs are exactly MEMRY_BLOCK_TYPES', () => {
    // #given / #when / #then a spec missing here is a replicated delete; a name
    // listed with no spec is a gate that silently covers nothing.
    expect(sorted(Object.keys(serverBlockSpecs()))).toEqual(sorted(MEMRY_BLOCK_TYPES))
  })

  it('the server inline specs are exactly MEMRY_INLINE_CONTENT_TYPES', () => {
    expect(sorted(Object.keys(serverInlineSpecs()))).toEqual(sorted(MEMRY_INLINE_CONTENT_TYPES))
  })

  it('the shared inline factory passes every declared type through', () => {
    // #given the one function both processes spread into `BlockNoteSchema.create`
    const specs = createMemryInlineContentSpecs(createServerInlineSpecs())

    // #when / #then dropping a line here removes the node from BOTH schemas at
    // once, which reads as "still in parity" to a naive name comparison.
    expect(sorted(Object.keys(specs))).toEqual(sorted(MEMRY_INLINE_CONTENT_TYPES))
  })

  it.each(MEMRY_BLOCK_TYPES)('%s reaches the assembled blockSchema', (type) => {
    expect(Object.keys(serverSchema().blockSchema)).toContain(type)
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s reaches the assembled inlineContentSchema', (type) => {
    expect(Object.keys(serverSchema().inlineContentSchema)).toContain(type)
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — the propSchema is the shared config's, not a copy
// ---------------------------------------------------------------------------

describe('every propSchema comes from the shared config', () => {
  // A block's propSchema is its (de)serialization contract: if the two
  // processes disagree, `yXmlFragmentToBlocks` mis-parses the props on one side
  // and the difference lands in the vault file.
  it.each(MEMRY_BLOCK_TYPES)('%s carries the shared block config', (type) => {
    const schema = serverSchema().blockSchema as Record<string, { propSchema: object }>
    expect(schema[type].propSchema).toEqual(BLOCK_CONFIGS[type].propSchema)
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s carries the shared inline config', (type) => {
    // `inlineContentSchema` holds `'text'`/`'link'` as bare strings alongside
    // the custom configs, so it is widened through `unknown` rather than cast.
    const schema = serverSchema().inlineContentSchema as unknown as Record<
      string,
      { propSchema: object }
    >
    expect(schema[type].propSchema).toEqual(INLINE_CONFIGS[type].propSchema)
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — the server implementations behave: no rich markup, and no throwing
// ---------------------------------------------------------------------------

describe('every server implementation emits exactly what it serializes', () => {
  // This is the gate a name+propSchema comparison cannot be: `render` is NOT
  // dead weight in the main process. BlockNote reaches it for inline content
  // inside a table and for anything it serializes without a `toExternalHTML`,
  // so a render that is rich rewrites the vault file and a render that throws
  // makes `yDocToMarkdown` return null for the whole document.
  it('has a fixture for every custom block type', () => {
    expect(sorted(Object.keys(BLOCK_FIXTURES))).toEqual(sorted(MEMRY_BLOCK_TYPES))
  })

  it('has a fixture for every custom inline type', () => {
    expect(sorted(Object.keys(INLINE_FIXTURES))).toEqual(sorted(MEMRY_INLINE_CONTENT_TYPES))
  })

  // A consistency check, not byte protection: every server spec currently
  // passes the SAME function reference as both `render` and `toExternalHTML`,
  // so this cannot catch the two going wrong together. What it does catch is
  // them diverging — which is how `linkMention` came to serialize the editor's
  // `<a>` chip into a table cell. The bytes themselves are gated against the
  // real converter in `blocknote-converter.test.ts`.
  it.each(MEMRY_BLOCK_TYPES)('%s renders exactly what it serializes', (type) => {
    // #given
    const impl = serverBlockSpecs()[type].implementation
    const block = BLOCK_FIXTURES[type]

    // #when — neither call may throw; that is half the assertion
    const rendered = impl.render(block, null)
    const external = impl.toExternalHTML?.(block, null, { nestingLevel: 0 })

    // #then
    expect(external).toBeDefined()
    expect(rendered.dom.outerHTML).toBe(external!.dom.outerHTML)
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s renders exactly what it serializes', (type) => {
    // #given
    const impl = serverInlineSpecs()[type].implementation
    const node = INLINE_FIXTURES[type]

    // #when
    const rendered = impl.render(node, null)
    const external = impl.toExternalHTML?.(node, null, { nestingLevel: 0 })

    // #then — `linkMention` shipped an `<a>` chip here and rewrote every
    // mention inside a table cell as a plain markdown link.
    //
    // Compared element-by-element rather than by `outerHTML`: BlockNote's
    // `createInlineContentSpec` decorates the RENDERED node's own attributes
    // with `data-inline-content-type` and one `data-*` per non-default prop,
    // and does not decorate `toExternalHTML`. Those attributes are the
    // framework's, they carry no text, and no markdown step reads them. The
    // tag, the markup inside it and the text are what BlockNote serializes,
    // and each of the two real bugs moved one of them: the rich chip was an
    // `<a>` wrapping `<img>`/`<span>`s whose text was the site label, not the
    // `((mention:…))` token.
    expect(external).toBeDefined()
    expect(rendered.dom.tagName).toBe(external!.dom.tagName)
    expect(rendered.dom.innerHTML).toBe(external!.dom.innerHTML)
    expect(rendered.dom.textContent).toBe(external!.dom.textContent)
  })

  it.each(MEMRY_BLOCK_TYPES)('%s renders without throwing on default props', (type) => {
    // #given the props BlockNote hands a freshly-created block: every default,
    // nothing populated. A spec that reads a prop it assumes is set throws here.
    const impl = serverBlockSpecs()[type].implementation
    const propSchema = BLOCK_CONFIGS[type].propSchema as Record<string, { default: unknown }>
    const props = Object.fromEntries(
      Object.entries(propSchema).map(([key, value]) => [key, value.default])
    )

    // #when / #then
    expect(() => impl.render({ id: 'blk', type, props, children: [] }, null)).not.toThrow()
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s renders without throwing on default props', (type) => {
    // #given
    const impl = serverInlineSpecs()[type].implementation
    const propSchema = INLINE_CONFIGS[type].propSchema as Record<string, { default: unknown }>
    const props = Object.fromEntries(
      Object.entries(propSchema).map(([key, value]) => [key, value.default])
    )

    // #when / #then
    expect(() => impl.render({ type, props }, null)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Gate 4 — every spec is registered under its own node name (#1455)
// ---------------------------------------------------------------------------

/**
 * The registration key and `config.type` are two different names for the same
 * node, and BlockNote does not make them agree. When they diverge, every guard
 * in this epic reads healthy and the content is lost anyway: ProseMirror builds
 * `config.type`, so y-prosemirror keeps the element and
 * `findUnrepresentableNodes` returns `[]`, while BlockNote — whose
 * `inlineContentSchema`/`blockSchema` is keyed by the REGISTRATION key — cannot
 * resolve the node when serializing and drops it. Measured on a schema keyed
 * `wikiLinkRenamed`: `See [[Wiki Link]] for details.` → `See for details.`
 *
 * Gates 1-3 above compare names, propSchemas and behaviour of the specs; this
 * one compares each spec's name to the slot it was put in.
 */
describe('every spec is registered under its own node type', () => {
  /** `config.type` for a spec object; the string itself for `text` / `link`. */
  function nodeTypeOf(config: unknown): unknown {
    return typeof config === 'string' ? config : (config as { type?: unknown }).type
  }

  it.each(MEMRY_BLOCK_TYPES)('the %s block spec is keyed by its config.type', (type) => {
    // #given / #when / #then derived from the exported list, so a spec added
    // under a mismatched key is covered without anyone remembering to add a case
    expect(serverBlockSpecs()[type].config.type).toBe(type)
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('the %s inline spec is keyed by its config.type', (type) => {
    expect(serverInlineSpecs()[type].config.type).toBe(type)
  })

  it('every key in the assembled blockSchema is that block’s own type', () => {
    // #given the WHOLE assembled map, BlockNote's defaults and the factory's
    // syntax-highlighting `codeBlock` included — not just Memry's five
    const schema = serverSchema().blockSchema as Record<string, unknown>

    // #when / #then
    for (const [key, config] of Object.entries(schema)) {
      expect(nodeTypeOf(config)).toBe(key)
    }
  })

  it('every key in the assembled inlineContentSchema is that node’s own type', () => {
    // #given `text` and `link` are bare strings here rather than configs, and
    // the string IS the node name — so they are checked, not skipped
    const schema = serverSchema().inlineContentSchema as unknown as Record<string, unknown>

    // #when / #then
    for (const [key, config] of Object.entries(schema)) {
      expect(nodeTypeOf(config)).toBe(key)
    }
  })

  it('refuses a block spec registered under another name', () => {
    // #given the issue's exact shape: a real spec put in the wrong slot. This is
    // reachable for blocks because `createMemrySchema` takes them free-form —
    // the renderer's React blocks reach no factory in this package. The cast is
    // what a real mistake needs now: the parameter's mapped type maps a
    // mis-keyed entry to `never`, so this is a compile error without it.
    const blocks = createServerBlockSpecs()
    const misKeyed = {
      ...blocks,
      bookmarkRenamed: blocks.bookmark
    } as unknown as ReturnType<typeof createServerBlockSpecs>

    // #when / #then the schema build fails, naming the slot and the node name
    expect(() =>
      createMemrySchema({ blocks: misKeyed, inline: createServerInlineSpecs() })
    ).toThrowError(/blockSpecs.*\["bookmarkRenamed"\].*config\.type is "bookmark"/s)
  })

  it('refuses an inline spec registered under another name', () => {
    // #given the same divergence on the inline half: the wikiLink slot holding a
    // spec that builds some other node. `createMemryInlineContentSpecs` writes
    // the four keys itself, so this is the only direction a mis-key can take
    // here — and it is the one that made y-prosemirror delete the element.
    const inline = createServerInlineSpecs()
    const renamed = {
      ...inline.wikiLink,
      config: { ...inline.wikiLink.config, type: 'wikiLinkRenamed' }
    } as unknown as MemryInlineSpecs['wikiLink']

    // #when / #then it throws at the factory, before any schema exists
    expect(() => createMemryInlineContentSpecs({ ...inline, wikiLink: renamed })).toThrowError(
      /inlineContentSpecs.*\["wikiLink"\].*config\.type is "wikiLinkRenamed"/s
    )
  })

  it('builds the shipped schema without throwing', () => {
    // #given both processes call `createMemrySchema` at MODULE SCOPE, so this
    // assertion firing on a shipped spec is a launch failure, not a test failure
    // #when / #then
    expect(() => serverSchema()).not.toThrow()
    expect(() => createServerBlockSpecs()).not.toThrow()
    expect(() => createMemryInlineContentSpecs(createServerInlineSpecs())).not.toThrow()
  })
})
