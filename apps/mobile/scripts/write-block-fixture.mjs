/**
 * Drop the block-coverage fixture into a DESKTOP vault folder, so desktop parses
 * it and mobile receives the result as Y.Doc state.
 *
 * The route is deliberate. Mobile's WebView seeds a note by handing raw markdown
 * to `editor.tryParseMarkdownToBlocks` (`apps/mobile/editor-web/src/main.ts`,
 * `mountDoc`), and none of the six custom block specs carries a `parse` rule:
 * `packages/editor-schema/src/blocks/configs.ts` is schema only, and
 * `server-specs.ts` supplies `render` plus `toExternalHTML` and nothing else. So
 * that call has no rule that turns `> [!info]` into a callout or
 * `<!-- file:{...} -->` into a file block, and seeding these bytes on the phone
 * would produce quotes and plain text instead of the custom nodes. The desktop
 * main process is what parses these markers into blocks; mobile then receives
 * the blocks through sync.
 *
 * So the note must be OPENED ONCE in the desktop app before it is worth
 * screenshotting on the phone, and that step is not optional for most of the
 * file. Measured against the real pipeline, not assumed: `markdownToBlocks`
 * alone yields callout, file, bookmark, youtubeEmbed, toggleListItem, table and
 * inlineImage. The other five — taskBlock, dateMention, linkMention,
 * inlineCheckbox and hashTag — are still literal text at that point and become
 * nodes only in `normalizeNoteBlocks` and `normalizeHashTags`, which are
 * RENDERER passes. They run when the editor opens the note, and what they
 * produce is what reaches the shared Y.Doc and therefore the phone.
 *
 *   1. node apps/mobile/scripts/write-block-fixture.mjs --vault <vault>
 *   2. open the note in the desktop app, once
 *   3. let it sync, then open it on the phone
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_NAME = 'Mobile block coverage.md'
const USAGE =
  'usage: node apps/mobile/scripts/write-block-fixture.mjs --vault <path> [--name <file.md>]\n'

function readFlag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const vault = readFlag('vault')
if (!vault) {
  process.stderr.write(USAGE)
  process.exit(1)
}

const fixture = readFileSync(
  fileURLToPath(new URL('../fixtures/block-coverage.md', import.meta.url)),
  'utf8'
)

const target = resolve(vault, readFlag('name') ?? DEFAULT_NAME)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, fixture)

console.log(target)
