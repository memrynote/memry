# Editor Schema as a Cross-Process Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for the main process to destroy a document node type that the renderer can produce.

**Architecture:** One BlockNote schema, defined once in a new `@memry/editor-schema` workspace package and built by both processes through a single factory. The renderer supplies React presentation; the main process gets headless serialization-only implementations generated from the _same_ configs. Independently, the CRDT→markdown export path stops operating on the live `Y.Doc` and stops writing the vault file when it cannot represent the document.

**Tech Stack:** TypeScript, `@blocknote/core` 0.47.1 (+ `@blocknote/react`, `@blocknote/server-util`), Yjs / y-prosemirror 1.3.7, Vitest, pnpm workspaces.

**Spec:** This document (the incident analysis below is the spec). Epic: see the GitHub epic that links this plan.

---

## The incident this exists to prevent

Opening a note containing `[[Wiki Link]]` on a sync-enabled device destroyed the link — in the editor, in the vault markdown, and on every other device.

1. `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts:28-34` registers custom **inline content specs**: `wikiLink`, `hashTag`, `linkMention`, `dateMention`.
2. `apps/desktop/src/main/sync/blocknote-converter.ts:77-83` (`serverSchema`) registers **no `inlineContentSpecs` at all**, and only `taskBlock` of the five custom block specs.
3. In collab mode `use-editor-sync.ts:318` runs `normalizeWikiLinks` on every change, so `[[X]]` becomes a `wikiLink` node inside the shared `Y.Doc`.
4. Write-back (`crdt-writeback.ts:401`) calls `yDocToMarkdown(doc)` **on the live doc** → `@blocknote/core/yjs` → y-prosemirror `createNodeFromYElement` → `schema.node('wikiLink', …)` throws.
5. y-prosemirror's catch is a destructive repair: `el._item.delete(transaction)` (`y-prosemirror@1.3.7/dist/y-prosemirror.cjs:878-885`). The node is deleted **from the shared doc**, producing a real CRDT delete that replicates everywhere; the markdown is then serialized from the already-mutated doc and written over the vault file.

Only sync users are affected: `ContentArea.tsx:1391-1396` gates collaboration on `isCollaborationActive(state.status)`, and the renderer's own save path knows `wikiLink` (its `toExternalHTML` re-emits `[[target|alias]]`).

**Node types main can currently destroy** (present in the renderer schema, absent from `serverSchema`):

| Kind             | Types                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline content   | `wikiLink`, `hashTag`, `linkMention`, `dateMention`                                                                                                  |
| Blocks           | `callout`, `youtubeEmbed`, `bookmark`                                                                                                                |
| Props-only drift | `file` — renderer overrides the default `file` spec, main uses BlockNote's default, so renderer-only props are dropped rather than the block deleted |

`taskBlock` is already hand-mirrored in `blocknote-converter.ts:52-97`, whose own comment says the propSchema "must stay identical to the renderer's" — i.e. this class of bug already happened once and was patched per-instance.

## Global Constraints

- **Live beta, backward compatibility mandatory.** No vault format change, no DB migration, no sync protocol change. Every change must be correct for notes written by older app versions and for docs already in the CRDT store.
- **No behaviour change to markdown output** except restoring content that is currently being dropped. Write-back is byte-compared (`crdt-writeback.ts:469`); a serialization change that alters bytes rewrites every note in every vault on next open.
- **`@memry/shared` stays dependency-free.** It types blocks structurally on purpose (`packages/shared/src/task-block.ts:4`). The new package is where `@blocknote/core` may be depended on.
- **Main process has no React.** Everything main imports must run under Node + jsdom (`@blocknote/server-util`); block _presentation_ stays in the renderer.
- Renderer↔main schema parity is a contract like IPC: it needs a test gate, not a comment.
- Architecture boundaries: main must not import from `apps/desktop/src/renderer/**` (`pnpm check:architecture`).
- Adding a workspace package touches the lockfile — expect renderer suite churn; run the full desktop suite, not a filtered one.

## File Structure

**Create — `packages/editor-schema/`**

| File                         | Responsibility                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`               | `@memry/editor-schema`, private, `exports` per entry point, dependency on `@blocknote/core` + `@blocknote/code-block`                     |
| `tsconfig.json`              | mirrors `packages/shared/tsconfig.json`                                                                                                   |
| `src/inline/wiki-link.ts`    | `wikiLink` spec — config + DOM render/parse/`toExternalHTML` (moved verbatim from the renderer)                                           |
| `src/inline/hash-tag.ts`     | `hashTag` spec (spec only; the tag-colour normalization stays in the renderer)                                                            |
| `src/inline/link-mention.ts` | `linkMention` spec                                                                                                                        |
| `src/inline/date-mention.ts` | `dateMention` spec                                                                                                                        |
| `src/inline/index.ts`        | `memryInlineContentSpecs` — the four, ready to spread                                                                                     |
| `src/blocks/configs.ts`      | `calloutConfig`, `fileConfig`, `youtubeEmbedConfig`, `bookmarkConfig`, `taskBlockConfig` — type + propSchema + content only, no rendering |
| `src/blocks/server-specs.ts` | `createServerBlockSpecs()` — headless `createBlockSpec(config, { render: throws, toExternalHTML })` per config                            |
| `src/schema.ts`              | `createMemrySchema(blockImplementations)` — the single factory both processes call                                                        |
| `src/index.ts`               | re-exports                                                                                                                                |
| `src/schema.test.ts`         | parity test: renderer-shaped schema vs server-shaped schema have identical node names and propSchemas                                     |

**Modify**

| File                                                                                                                                 | Change                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/sync/blocknote-converter.ts:52-97`                                                                            | drop the hand-mirrored `createServerTaskBlock` and the local `BlockNoteSchema.create`; build via `createMemrySchema(createServerBlockSpecs())` |
| `apps/desktop/src/main/sync/blocknote-converter.ts:99-113`                                                                           | `yDocToMarkdown` converts a snapshot copy, never the live doc                                                                                  |
| `apps/desktop/src/main/sync/crdt-writeback.ts:400-420`                                                                               | fail closed on unrepresentable content                                                                                                         |
| `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`                                                        | build via `createMemrySchema({ …React block impls })`; import inline specs from the package                                                    |
| `apps/desktop/src/renderer/src/components/note/content-area/{wiki-link,hash-tag,link-mention,date-mention}.ts(x)`                    | keep renderer-only helpers, re-export the spec from the package                                                                                |
| `apps/desktop/src/renderer/src/components/note/content-area/{callout,file,youtube-embed,bookmark}-block.tsx`, `task-block/index.tsx` | take their config from the package instead of declaring it inline                                                                              |

---

### Task 1: Export path must never mutate the live doc

**Files:**

- Modify: `apps/desktop/src/main/sync/blocknote-converter.ts:99-113`
- Test: `apps/desktop/src/main/sync/blocknote-converter.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `yDocToMarkdown(doc: Y.Doc, fragmentName?: string): Promise<string | null>` — unchanged signature, now guaranteed side-effect-free on `doc`

- [x] **Step 1: Write the failing test**

```ts
it('never mutates the live doc, even for a node type the schema does not know', async () => {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  // A block containing an inline node the server schema cannot build.
  const block = new Y.XmlElement('blockContainer')
  block.setAttribute('id', 'b1')
  const para = new Y.XmlElement('paragraph')
  const unknown = new Y.XmlElement('wikiLink')
  unknown.setAttribute('target', 'Roadmap')
  para.insert(0, [unknown])
  block.insert(0, [para])
  fragment.insert(0, [block])

  const before = Y.encodeStateAsUpdate(doc)
  await yDocToMarkdown(doc)

  expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
})
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @memry/desktop test:main -- blocknote-converter`
Expected: FAIL — the encoded state differs, because y-prosemirror deleted the `wikiLink` item.

- [x] **Step 3: Convert on a snapshot copy**

```ts
export async function yDocToMarkdown(
  doc: Y.Doc,
  fragmentName = CRDT_FRAGMENT_NAME
): Promise<string | null> {
  try {
    // y-prosemirror's `createNodeFromYElement` DELETES any element it cannot
    // build (dist/y-prosemirror.cjs:878-885) — a repair heuristic that, run on
    // the live doc, turns a serialization gap into replicated data loss. Read
    // from a detached copy so this path can only ever read.
    const snapshot = new Y.Doc()
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc))
    const editor = getEditor()
    const blocks = editor.yXmlFragmentToBlocks(snapshot.getXmlFragment(fragmentName))
    if (blocks.length === 0) return ''
    return await blocksToMarkdownPreserving(editor, blocks as Block[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}
```

- [x] **Step 4: Run the test again**

Run: `pnpm --filter @memry/desktop test:main -- blocknote-converter`
Expected: PASS.

- [x] **Step 5: Guard the cost**

The copy is one `encodeStateAsUpdate` + `applyUpdate` per write-back pass. Write-back is already paced by its own cost (`WRITEBACK_COOLDOWN_FACTOR`), so measure a 49KB note before/after and record the delta in the PR body. If it is material, cache the copy per (noteId, stateVector).

**Measured** (38KB markdown / 104KB Y update, Node + jsdom, mean of 10): `yDocToMarkdown` 21.6ms, of which the snapshot copy is 1.79ms (~8%); `findUnrepresentableNodes` 0.11ms. Not material against a 9× cooldown — no caching needed.

- [x] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/blocknote-converter.ts apps/desktop/src/main/sync/blocknote-converter.test.ts
git commit -m "fix(crdt): serialize markdown from a doc snapshot, never the live doc"
```

---

### Task 2: Fail closed — never overwrite the vault file with a lossy serialization

**Files:**

- Modify: `apps/desktop/src/main/sync/blocknote-converter.ts` (new export), `apps/desktop/src/main/sync/crdt-writeback.ts:400-420`
- Test: `apps/desktop/src/main/sync/crdt-writeback.test.ts`

**Interfaces:**

- Consumes: `yDocToMarkdown` from Task 1
- Produces: `findUnrepresentableNodes(doc: Y.Doc, fragmentName?: string): string[]` — node names present in the fragment that the server schema cannot build

- [x] **Step 1: Write the failing test**

```ts
it('keeps the file and reports when the doc holds a node the schema cannot represent', async () => {
  const { doc } = seedDocWithUnknownInlineNode('wikiLink')
  const before = await readFile(notePath, 'utf8')

  await performWritebackForTest('note-1', doc)

  expect(await readFile(notePath, 'utf8')).toBe(before)
  expect(trackMainLog).toHaveBeenCalledWith(
    'error',
    expect.objectContaining({
      action: 'writeback_unrepresentable_node'
    })
  )
})
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @memry/desktop test:main -- crdt-writeback`
Expected: FAIL — the file is rewritten without the node.

- [x] **Step 3: Implement the check**

**Corrected during implementation.** The hand-written set this step originally sketched (blockSchema keys + inlineContentSchema keys + `BLOCK_CONTAINER_NODES` + `blockGroup`) is wrong: PM node names are not block type names. A real fragment also carries `tableRow`, `tableCell`, `tableHeader` and `tableParagraph`, none of which appear in `blockSchema` — the list would flag them and strand every note containing a table. Verified by mutation: swapping the list back in turns the table case RED with `['tableRow','tableHeader','tableCell','tableParagraph']`.

Ask the ProseMirror schema instead — it is the same object `createNodeFromYElement` calls `schema.node(name, …)` on, so it cannot drift from what is actually constructible:

```ts
export function findUnrepresentableNodes(doc: Y.Doc, fragmentName = CRDT_FRAGMENT_NAME): string[] {
  try {
    const known = getEditor().editor.pmSchema.nodes
    const unknown = new Set<string>()
    const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
      for (const child of node.toArray()) {
        const el = child as Y.XmlElement
        if (typeof el.nodeName !== 'string') continue
        if (!(el.nodeName in known)) unknown.add(el.nodeName)
        visit(el)
      }
    }
    visit(doc.getXmlFragment(fragmentName))
    return [...unknown]
  } catch (err) {
    log.error('Unrepresentable-node scan failed', err)
    return []
  }
}
```

Marks need no equivalent check today: neither schema passes `styleSpecs`, so both carry exactly the default mark set (`bold`, `italic`, `underline`, `strike`, `code`, `link`, `textColor`, `backgroundColor`, plus the CriticMarkup three). A custom style spec added to the renderer later would reopen this — `createTextNodesFromYText` drops the whole `Y.Text` on an unknown mark.

`trackMainLog` takes no free-form fields, so the node list rides on `errorCode` (sanitized by `toSafeToken`), not a `nodes` key.

In `performWriteback`, before writing:

```ts
const unrepresentable = findUnrepresentableNodes(doc)
if (unrepresentable.length > 0) {
  log.error('Doc holds node types this build cannot serialize; keeping the file', {
    noteId,
    nodes: unrepresentable
  })
  if (shouldEmitThrottled(`writeback_unrepresentable:${noteId}`)) {
    trackMainLog('error', {
      scope: 'CrdtWriteback',
      action: 'writeback_unrepresentable_node',
      nodes: unrepresentable.join(',')
    })
  }
  return
}
```

- [x] **Step 4: Run the test again**

Run: `pnpm --filter @memry/desktop test:main -- crdt-writeback`
Expected: PASS.

- [x] **Step 5: Verify the stale-file path is honest**

Confirm the existing `markdown === null` branch (`crdt-writeback.ts:412-420`) still fires its telemetry, and that neither branch clears `pendingTimers` in a way that suppresses the next legitimate write-back. Add an assertion that a subsequent representable edit does write.

- [x] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/blocknote-converter.ts apps/desktop/src/main/sync/crdt-writeback.ts apps/desktop/src/main/sync/crdt-writeback.test.ts
git commit -m "fix(crdt): keep the vault file when write-back cannot represent the doc"
```

---

### Task 3: Create `@memry/editor-schema` and move the four inline specs into it

**Files:**

- Create: `packages/editor-schema/{package.json,tsconfig.json}`, `packages/editor-schema/src/inline/{wiki-link,hash-tag,link-mention,date-mention,index}.ts`, `packages/editor-schema/src/schema.ts`, `packages/editor-schema/src/index.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`, and the four renderer spec files (keep helpers, re-export the spec)
- Test: `packages/editor-schema/src/inline/wiki-link.test.ts` (move the existing renderer spec tests that cover the spec itself)

**Interfaces:**

- Consumes: nothing
- Produces:
  - `memryInlineContentSpecs` — `{ wikiLink, hashTag, linkMention, dateMention }`
  - `createMemrySchema(blockImplementations: Record<'callout'|'file'|'youtubeEmbed'|'bookmark'|'taskBlock', BlockSpec>): BlockNoteSchema`

- [x] **Step 1: Scaffold the package**

`packages/editor-schema/package.json`, mirroring `packages/shared/package.json` but with a real dependency:

```json
{
  "name": "@memry/editor-schema",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./inline": "./src/inline/index.ts",
    "./blocks": "./src/blocks/configs.ts",
    "./server": "./src/blocks/server-specs.ts"
  },
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": {
    "@blocknote/core": "0.47.1",
    "@blocknote/code-block": "*"
  },
  "devDependencies": { "@memry/typescript-config": "workspace:*" }
}
```

Pin `@blocknote/*` to the exact versions already in `apps/desktop/package.json` — two copies of `@blocknote/core` in one process would produce two different schema identities.

- [x] **Step 2: Move the specs verbatim**

**Corrected during implementation.** They are all `createInlineContentSpec` with vanilla-DOM renders, but only two are _portable_:

| Spec          | `render` imports                                                                                                    | Moves?                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `wikiLink`    | none                                                                                                                | whole spec                               |
| `linkMention` | none                                                                                                                | whole spec                               |
| `dateMention` | `@/lib/time-format`, `@/lib/week-start`, `date-fns`, module-level `prefClockFormat`                                 | config + `parse` + `toExternalHTML` only |
| `hashTag`     | `@/components/note/tags-row/tag-colors`, `@/components/note/note-title/emoji-icon-utils`, `@/lib/hugeicon-renderer` | config + `parse` + `toExternalHTML` only |

So inline specs take the same shape the plan already uses for blocks — the package owns the serialization contract, each process supplies presentation:

```ts
export const hashTagConfig = { type: 'hashTag', propSchema: { … }, content: 'none' } as const
export const hashTagSerialization = { parse, toExternalHTML }   // both portable
export const createHashTagSpec = (render) =>
  createInlineContentSpec(hashTagConfig, { render, ...hashTagSerialization })
```

`toExternalHTML` is what main actually needs, and it is portable for all four (`dateMention`'s token comes from `@memry/shared/date-mention`, which main already imports). Keep `normalizeWikiLinks`, the suggestion menus, hover cards, `setDateMentionPrefs` and the tag colour map in the renderer.

**Mechanism verified before building any of this** (throwaway spike, since the whole package rests on it): register a server-side `wikiLink` inline spec whose `render` throws and whose `toExternalHTML` emits the `[[…]]` text, then run a doc holding a `wikiLink` node through `yXmlFragmentToBlocks` → `blocksToMarkdownLossy`. Result: the node survives as inline content (`{"type":"wikiLink","props":{"target":"Roadmap","alias":"the plan"}}`), the markdown is `See [[Roadmap|the plan]] tomorrow.`, `render` is never reached, and `Y.encodeStateAsUpdate` is byte-identical before and after. Registering the spec is both necessary and sufficient.

- [x] **Step 3: Write the factory**

```ts
// packages/editor-schema/src/schema.ts
export function createMemrySchema(blockImplementations: MemryBlockImplementations) {
  return BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      codeBlock: createCodeBlockSpec(codeBlockOptions),
      ...blockImplementations
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      ...memryInlineContentSpecs
    }
  })
}
```

- [x] **Step 4: Point the renderer at it**

`editor-schema.ts` becomes `createMemrySchema({ file: createFileBlock(), callout: createCalloutBlock(), youtubeEmbed: createYoutubeEmbedBlock(), bookmark: createBookmarkBlock(), taskBlock: createTaskBlock() })`, with the inline specs no longer listed there at all.

- [x] **Step 5: Prove the renderer is unchanged**

Run: `pnpm --filter @memry/desktop test:renderer` and `pnpm --filter @memry/desktop typecheck`
Expected: PASS with no snapshot churn. Renderer behaviour must be byte-identical; this task is a move, not a change.

- [x] **Step 6: Commit**

```bash
git add packages/editor-schema apps/desktop/src/renderer/src/components/note/content-area pnpm-lock.yaml
git commit -m "refactor(editor): extract the shared BlockNote schema into @memry/editor-schema"
```

---

### Task 4: Main builds its schema from the same factory

**Files:**

- Create: `packages/editor-schema/src/blocks/{configs.ts,server-specs.ts}`
- Modify: `apps/desktop/src/main/sync/blocknote-converter.ts:52-97`
- Test: `apps/desktop/src/main/sync/blocknote-converter.test.ts`

**Interfaces:**

- Consumes: `createMemrySchema` (Task 3)
- Produces: `createServerBlockSpecs(): MemryBlockImplementations` — headless implementations built from the shared configs

- [x] **Step 1: Write the failing test**

```ts
it('round-trips a wiki link through the CRDT write path', async () => {
  const doc = new Y.Doc()
  await markdownToYFragment(
    'See [[Roadmap|the plan]] tomorrow.',
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  )
  // Simulate the renderer promoting the text to a node.
  promoteWikiLinksInFragment(doc, CRDT_FRAGMENT_NAME)

  const markdown = await yDocToMarkdown(doc)

  expect(markdown).toContain('[[Roadmap|the plan]]')
  expect(findUnrepresentableNodes(doc)).toEqual([])
})
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @memry/desktop test:main -- blocknote-converter`
Expected: FAIL — the link is missing from the markdown.

- [x] **Step 3: Move the taskBlock config and add headless specs**

```ts
// packages/editor-schema/src/blocks/server-specs.ts
const serverImplementation = (config: BlockConfig) => ({
  render: () => {
    throw new Error(`${config.type} server spec is serialization-only and must not be rendered`)
  }
})

export function createServerBlockSpecs(): MemryBlockImplementations {
  return {
    taskBlock: createBlockSpec(taskBlockConfig, serverImplementation(taskBlockConfig))()
    // callout / file / youtubeEmbed / bookmark land in Task 5
  }
}
```

- [x] **Step 4: Rewrite `serverSchema`**

**Corrected during implementation.** `createMemrySchema` takes `{ blocks, inline }` (Task 3 Step 3), and the inline half is the half that closes the incident:

```ts
const serverSchema = createMemrySchema({
  blocks: createServerBlockSpecs(),
  inline: createServerInlineSpecs()
})
```

`createServerInlineSpecs` lives in `packages/editor-schema/src/server.ts`, which the package's `exports` already pointed at.

Delete `createServerTaskBlock` and its comment — the propSchema is now shared, so the warning it carried no longer applies.

**`wikiLink` cannot be shared whole after all.** Task 3 Step 2 marked it "portable — whole spec", and it is, for rendering. But its `parse` promotes ANY element whose entire text reads `[[X]]` into an inline node. In the editor that is a paste convenience; in main's markdown importer it eats the block around the link. Measured against `HEAD~`: `- [[A]]\n- [[B]]` came back as `[[A]] [[B]]`, `> [[Quoted]]` as `[[Quoted]]`, and a `| [[A]] |` table cell as `| A |` — three silent rewrites of existing vault notes, none of which any pre-existing test covered. So main takes `WikiLinkSerializationOnly` (same config, same `toExternalHTML`, no `parse`) and `MemryInlineSpecs` grows a `wikiLink` entry each process fills in. Markdown output is now byte-identical to `HEAD~` for every fixture, and `blocknote-converter.test.ts` keeps the fixtures that caught it.

- [x] **Step 5: Run the tests**

Run: `pnpm --filter @memry/desktop test:main` and `pnpm --filter @memry/desktop test:renderer` (the `-- <path>` filter is silently ignored; use `pnpm exec vitest run --config config/vitest.config.ts --project main <path>` from `apps/desktop` for one file).
Result: main 512 files / 6352 tests, renderer 609 files / 6965 tests, both green, with the pre-existing round-trip and note-fidelity tests untouched.

- [x] **Step 6: Commit**

```bash
git add packages/editor-schema apps/desktop/src/main/sync/blocknote-converter.ts apps/desktop/src/main/sync/blocknote-converter.test.ts
git commit -m "fix(crdt): build the main-process schema from the shared factory"
```

---

### Task 5: Custom blocks — callout, youtubeEmbed, bookmark, file

**Files:**

- Modify: `packages/editor-schema/src/blocks/{configs.ts,server-specs.ts}`, the four renderer block files, `apps/desktop/src/main/sync/blocknote-converter.ts`
- Test: `packages/editor-schema/src/blocks/server-specs.test.ts`, `apps/desktop/src/main/sync/blocknote-converter.test.ts`

**Interfaces:**

- Consumes: `createServerBlockSpecs` (Task 4)
- Produces: the same function, now returning all five implementations

- [ ] **Step 1: Establish each block's markdown form from the current renderer save path**

For each of `callout`, `youtubeEmbed`, `bookmark`, `file`, write down what the renderer writes to disk today (see `file-block-markers.ts`, `@memry/shared/youtube`, and the existing round-trip tests). That output is the contract — the server `toExternalHTML` must reproduce it byte-for-byte, or every note holding one of these blocks gets rewritten on next open.

- [ ] **Step 2: Write the failing round-trip test, one case per block type**

```ts
it.each(['callout', 'youtubeEmbed', 'bookmark', 'file'])(
  '%s survives markdown → doc → markdown unchanged',
  async (type) => {
    const markdown = fixtureFor(type)
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    expect(await yDocToMarkdown(doc)).toBe(markdown)
  }
)
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @memry/desktop test:main -- blocknote-converter`
Expected: FAIL for every case.

- [ ] **Step 4: Move each config into the package and add its server implementation**

One block at a time, each with its own `toExternalHTML`. The renderer keeps `createReactBlockSpec` but takes `type`/`propSchema`/`content` from the shared config, so the two can no longer disagree.

Note `file`: the renderer _overrides_ BlockNote's default `file` spec. Once the config is shared, main stops using the default and stops silently dropping renderer-only props.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @memry/desktop test:main` and `pnpm --filter @memry/desktop test:renderer`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/editor-schema apps/desktop/src/renderer/src/components/note/content-area apps/desktop/src/main/sync/blocknote-converter.ts
git commit -m "fix(crdt): teach the main-process schema the custom block types"
```

---

### Task 6: The contract gate

**Files:**

- Create: `packages/editor-schema/src/schema.test.ts`
- Test: also `apps/desktop/src/main/sync/blocknote-converter.test.ts`

**Interfaces:**

- Consumes: `createMemrySchema`, `createServerBlockSpecs`
- Produces: a failing test the moment a spec exists on one side only

- [ ] **Step 1: Write the parity test**

```ts
it('renderer and server schemas expose the same node types', () => {
  const server = createMemrySchema(createServerBlockSpecs())
  expect(Object.keys(server.blockSchema).sort()).toEqual(
    Object.keys(rendererLikeSchema.blockSchema).sort()
  )
  expect(Object.keys(server.inlineContentSchema).sort()).toEqual(
    Object.keys(rendererLikeSchema.inlineContentSchema).sort()
  )
})

it('shared configs are the single source of propSchemas', () => {
  for (const type of Object.keys(MEMRY_BLOCK_CONFIGS)) {
    expect(server.blockSchema[type].propSchema).toEqual(MEMRY_BLOCK_CONFIGS[type].propSchema)
  }
})
```

- [ ] **Step 2: Write the enumerated round-trip test**

Table-driven over every custom type: build a doc holding one, run `yDocToMarkdown`, assert (a) the doc is unchanged, (b) the markdown carries the node's textual form. A new spec with no fixture must fail the test rather than be skipped.

- [ ] **Step 3: Verify the gate actually catches the regression**

Temporarily delete `wikiLink` from `memryInlineContentSpecs`, run the suite, confirm RED, restore. Record the observed failure output in the PR body — a gate nobody has seen fail is not a gate.

- [ ] **Step 4: Wire it into CI**

The package needs to be part of `pnpm test` / `pnpm typecheck` via turbo like `@memry/shared`. Confirm with a deliberate failure that CI reports it.

- [ ] **Step 5: Commit**

```bash
git add packages/editor-schema apps/desktop/src/main/sync/blocknote-converter.test.ts turbo.json
git commit -m "test(editor): gate renderer↔main schema parity"
```

---

### Task 7: Opening a note must not rewrite it

**Files:**

- Test: `apps/desktop/src/main/sync/note-fidelity-roundtrip.test.ts`, plus an E2E in `apps/desktop/e2e`

**Interfaces:**

- Consumes: everything above
- Produces: byte-stability coverage for the open→write-back cycle

- [ ] **Step 1: Write the failing test**

Seed a vault note whose markdown contains `[[Wiki Link]]`, a `#hashtag`, a date mention and a callout. Open it with collaboration active, let write-back run, assert the file is byte-identical.

- [ ] **Step 2: Cover the oscillation explicitly**

`use-editor-sync.ts:318` promotes `[[X]]` text to a `wikiLink` node on every change, including in collab mode, while main serializes the node back to text. Assert this converges: two consecutive open→write-back cycles produce identical bytes and no CRDT delete of a wiki link. If it does not converge, the canonical form must be decided in this task and documented in the package README.

- [ ] **Step 3: Run it**

Run: `pnpm --filter @memry/desktop test:main -- note-fidelity` and `pnpm test:e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/sync/note-fidelity-roundtrip.test.ts apps/desktop/e2e
git commit -m "test(notes): opening a note with wiki links is a no-op write-back"
```

---

### Task 8: Size and repair the damage already done

**Files:**

- Create: a one-off audit script under `apps/desktop/scripts/`
- Modify: telemetry only; no user-facing UI unless the audit says it is warranted

**Interfaces:**

- Consumes: `findUnrepresentableNodes` (Task 2)
- Produces: a count of affected notes and a documented recovery path

- [ ] **Step 1: Measure the blast radius**

Notes were losing wiki links, callouts, bookmarks and YouTube embeds on every open, for every sync-enabled device, for as long as the mismatch existed. Establish when each spec was added to the renderer schema (`git log` on `editor-schema.ts`) — that dates the start of each type's loss.

- [ ] **Step 2: Establish what is recoverable**

Two sources: note snapshots created during write-back (`maybeCreateSignificantSnapshot`, `crdt-writeback.ts:476`), and the CRDT update history on the sync server, where the original insert still exists behind a tombstone. Write the audit script against a copy of a real vault, never in place.

- [ ] **Step 3: Decide the user-facing response**

Options, to be decided with Kaan once the count is known: silent repair on next open, a one-time "we found N notes with removed links" review surface, or documentation only. Do not ship a repair that rewrites notes automatically before the count is known.

- [ ] **Step 4: Commit the findings**

Record the numbers in the epic, not only in a commit message.

---

## Self-Review

**Spec coverage:** every node type named in the incident table is covered — inline by Tasks 3–4, blocks by Task 5, `file` props by Task 5 Step 4. The two mechanism-level faults (live-doc mutation, silent lossy overwrite) are Tasks 1–2 and land before any schema work. The drift that caused it is gated by Task 6, the oscillation by Task 7, the existing damage by Task 8.

**Ordering:** Tasks 1 and 2 are independent of the package and must ship first — together they downgrade this class from "permanent replicated data loss" to "a note stops write-back until the app can represent it".

**Type consistency:** `createMemrySchema`, `createServerBlockSpecs`, `memryInlineContentSpecs`, `MEMRY_BLOCK_CONFIGS` and `findUnrepresentableNodes` are used with the same names and signatures in every task that references them.
