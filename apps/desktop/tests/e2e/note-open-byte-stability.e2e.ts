// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Opening a note must not rewrite it — the real app (#1434, phase 3 of #1427).
 *
 * The unit suites cover the two halves of the loop separately
 * (`src/main/sync/note-open-byte-stability.test.ts` and
 * `src/renderer/.../wiki-link-collab-promotion.test.ts`). Neither can run the
 * whole thing: the renderer's promotion only happens inside a real editor, and
 * the editor only binds to the shared Y.Doc when collaboration is live — which
 * `ContentArea` gates on `isCollaborationActive(syncStatus)`, i.e. on an
 * AUTHENTICATED sync session. That is why this file uses the sync-auth fixture
 * rather than the single-app one: without a bootstrapped device the editor
 * takes the non-collaborative path and the loop under test never runs.
 *
 * The note is seeded as BYTES on disk, not through the app, because the whole
 * claim is about bytes the user (or Obsidian) wrote.
 *
 * ## The one this suite found, now fixed (#1454)
 *
 * Opening a note whose body contained a plain `#hashtag` used to INJECT a
 * `tags:` block into its frontmatter. A body tag is index-only — search and the
 * tag hub merge it in (`extractNoteMetadata`) without touching the file — but
 * that merged list was also handed to `CrdtProvider.initForNote`, and
 * write-back treats the doc's tag array as authoritative for `tags:`
 * (`mergeFrontmatter`). The last test in this file asserts the file is now
 * byte-identical; the mechanism is pinned in
 * `src/main/sync/note-open-byte-stability.test.ts`.
 *
 * The body-stability tests above still strip frontmatter, so they measure the
 * wiki-link loop they are named for rather than this.
 */

import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  getNoteHandleByTitle,
  getWritebackDebugById,
  openNoteByTitle
} from './utils/note-sync-helpers'
import { waitForSyncOnline } from './utils/network-control'
import { SELECTORS } from './utils/electron-helpers'

/** Everything the issue names, in one note. */
const BODY = [
  '# Weekly',
  '',
  'See [[Wiki Link]] and #hashtag on ((date:eyJhbmNob3JJZCI6ImExIn0)).',
  '',
  '- [[A]]',
  '- [[B]]',
  '',
  '> [!info]',
  '> Heads up'
].join('\n')

/** The same note with no inline hash tag, so nothing touches its frontmatter. */
const BODY_WITHOUT_HASH_TAG = BODY.replace(' and #hashtag', '')

function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/** Drop the YAML frontmatter block, leaving the body this loop actually owns. */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/)
  return match ? markdown.slice(match[0].length) : markdown
}

/**
 * The bytes the file settles on once the indexer has claimed it.
 *
 * Indexing a file that has never been seen can rewrite it before any editor
 * exists, which is not what this test is about. The baseline is taken after the
 * note is in the index and the file has stopped moving, so what is measured is
 * exactly "did OPENING it change anything".
 */
async function indexedBaseline(page, title: string, absPath: string) {
  const note = await getNoteHandleByTitle(page, title)
  let bytes = fs.readFileSync(absPath, 'utf8')
  // Two consecutive identical reads a second apart: the file has stopped moving.
  await expect
    .poll(
      () => {
        const next = fs.readFileSync(absPath, 'utf8')
        const settled = next === bytes
        bytes = next
        return settled
      },
      { timeout: 20_000, intervals: [1000] }
    )
    .toBe(true)
  return { id: note.id, bytes }
}

async function openInEditor(page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** How many times write-back has run for this note so far. */
async function getWritebackRuns(electronApp, noteId: string): Promise<number> {
  return (await getWritebackDebugById(electronApp, noteId))?.performedCount ?? 0
}

/** Wait until write-back has actually run for this note at least `count` times. */
async function waitForWritebackRuns(electronApp, noteId: string, count: number): Promise<void> {
  await expect
    .poll(async () => (await getWritebackDebugById(electronApp, noteId))?.performedCount ?? 0, {
      timeout: 30_000
    })
    .toBeGreaterThanOrEqual(count)
}

test.describe('Note open byte stability', () => {
  test('opening a seeded note with collaboration active leaves its body untouched', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    // #given a vault note written straight to disk
    const title = `Byte Stability ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes).toContain('[[Wiki Link]]')

    // #when it is opened in the real editor, on the collaborative path…
    await openInEditor(pageA, title)
    // …and write-back has genuinely run (otherwise this test passes vacuously)
    await waitForWritebackRuns(electronAppA, baseline.id, 1)

    // #then the body is byte-identical: the wiki links the renderer promoted to
    // nodes came back as the same `[[…]]` text, in the same blocks, and the
    // callout and date-mention token were never parsed at all
    expect(stripFrontmatter(fs.readFileSync(absPath, 'utf8'))).toBe(
      stripFrontmatter(baseline.bytes)
    )
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()
  })

  test('a note with no inline tag is byte-identical, frontmatter included', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    // #given
    const title = `Byte Stability Whole File ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, BODY_WITHOUT_HASH_TAG)
    const baseline = await indexedBaseline(pageA, title, absPath)

    // #when
    await openInEditor(pageA, title)
    await waitForWritebackRuns(electronAppA, baseline.id, 1)

    // #then nothing about the file changed at all
    expect(fs.readFileSync(absPath, 'utf8')).toBe(baseline.bytes)
  })

  test('a second open -> write-back cycle produces the same bytes', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    // #given a note that has already been opened once, so whatever the first
    // open was going to do to it has happened
    const title = `Byte Stability Twice ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, BODY)
    const first = await indexedBaseline(pageA, title, absPath)
    await openInEditor(pageA, title)
    await waitForWritebackRuns(electronAppA, first.id, 1)
    await expect
      .poll(() => stripFrontmatter(fs.readFileSync(absPath, 'utf8')), { timeout: 20_000 })
      .toBe(stripFrontmatter(first.bytes))
    const afterFirstOpen = fs.readFileSync(absPath, 'utf8')
    // `performedCount` lives in the MAIN process and is only cleared by
    // `CrdtProvider.destroy()`, which a renderer reload does not trigger — so
    // waiting for `>= 1` again would return immediately and this test would
    // measure the first cycle twice. Capture the count and wait past it.
    const runsAfterFirstOpen = await getWritebackRuns(electronAppA, first.id)

    // #when the app is reloaded and the note opened again — a cold open, with
    // the shared doc rebuilt from the CRDT store
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForSyncOnline(pageA, 60_000)
    await openInEditor(pageA, title)
    await waitForWritebackRuns(electronAppA, first.id, runsAfterFirstOpen + 1)

    // #then the second cycle is a fixed point — whole file this time, since the
    // first open already settled the frontmatter
    await expect
      .poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 })
      .toBe(afterFirstOpen)
  })

  test('an inline #hashtag does not add a tags: block on first open', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    // #given a note with no frontmatter and one inline hash tag in its body —
    // an Obsidian user who keeps tags in the body and not in frontmatter
    const title = `Inline Tag Frontmatter ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, 'Tagged #hashtag here.')
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes).not.toContain('tags:')

    // #when it is opened, and write-back has genuinely run
    await openInEditor(pageA, title)
    await waitForWritebackRuns(electronAppA, baseline.id, 1)

    // #then the whole file is byte-identical: the tag stays where the user put
    // it. It reaches search and the tag hub through the index (#1454), not by
    // rewriting the file. This test used to assert the opposite, as a pin.
    expect(fs.readFileSync(absPath, 'utf8')).toBe(baseline.bytes)
    expect(fs.readFileSync(absPath, 'utf8')).not.toContain('tags:')

    // and the note really does carry the tag, so this is not a lost feature
    const note = await getNoteHandleByTitle(pageA, title)
    const tags = await pageA.evaluate(
      (id) => window.api.notes.get(id).then((loaded) => loaded?.tags ?? []),
      note.id
    )
    expect(tags).toContain('hashtag')
  })
})
