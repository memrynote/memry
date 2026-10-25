/**
 * Oracle op `memry-parse` (stage 4 of #3522): the Electron converter's whole
 * markdown-to-seed path, `prepareFragmentSeed`, with every memry layer on top
 * of BlockNote's parse: writing markers, CriticMarkup, link references, embed
 * resolution, inline colours, column and toggle regions, blank-line gaps,
 * sidecar and nesting markers, custom block markers, task and plain
 * checkboxes.
 *
 * Callout and structured-quote claims are decided by re-serializing the parsed
 * body (`resolveCalloutRun`, `resolveQuoteRun`), which needs the block
 * serializer of stage 5. `claims` counts the runs the readers returned, so a
 * case that needed the serializer is marked `deferred`: the Rust pipeline must
 * reach its serializer on exactly those cases.
 */
import { setCalloutTypeDefinitions } from '@memry/editor-schema/blocks'

import { prepareFragmentSeed } from '../../src/main/sync/blocknote-converter'
import { canonicalBlocks } from './bn-oracle'

export const claims = { count: 0 }

interface CalloutTypeInput {
  name: string
  label: string
  color: string
  icon: string
}

export interface MemryParseInput {
  markdown: string
  notePath?: string
  calloutTypes?: CalloutTypeInput[]
  writing?: unknown
}

export async function memryParse(input: MemryParseInput): Promise<unknown> {
  setCalloutTypeDefinitions(input.calloutTypes ?? [])
  claims.count = 0
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job's `writing` is a WritingFrontmatter written by the case list
  const writing = input.writing as Parameters<typeof prepareFragmentSeed>[2]
  const seed = await prepareFragmentSeed(input.markdown, input.notePath, writing)
  const deferred = claims.count > 0
  setCalloutTypeDefinitions([])
  if (!seed) return { seed: null, deferred }
  return {
    seed: {
      blocks: canonicalBlocks(seed.blocks),
      criticMarks: seed.marks,
      definitions: seed.definitions,
      usages: seed.usages,
      plainText: seed.plainText,
      writingSentinels: Object.fromEntries(seed.writingSentinels)
    },
    deferred
  }
}
