/**
 * The oracle functions of the `markers` layer: thin JSON adapters over
 * `@memry/shared` (block-colors, block-markers, link-card-marker,
 * inline-colors, task-block, plain-checkbox, obsidian-tasks). A closure result
 * (`SidecarPatch`) is run on the argument block and the block comes back; a
 * `Map` comes back as `[key, value]` pairs.
 */
import * as blockColors from '@memry/shared/block-colors'
import * as blockMarkers from '@memry/shared/block-markers'
import * as inlineColors from '@memry/shared/inline-colors'
import * as obsidian from '@memry/shared/obsidian-tasks'
import * as plainCheckbox from '@memry/shared/plain-checkbox'
import * as taskBlock from '@memry/shared/task-block'

import * as linkCard from '../../../../../packages/shared/src/link-card-marker'
import { MD_FNS } from './markers-md'

type Fn = (...args: never[]) => unknown
type Block = blockMarkers.MarkedBlock
type Blocks = Parameters<typeof inlineColors.extractInlineColorRuns>[0]
type TaskBlocks = Parameters<typeof taskBlock.normalizeTaskBlocks>[0]
type PlainBlocks = Parameters<typeof plainCheckbox.normalizePlainCheckboxes>[0]

export const MARKER_FNS: Record<string, Fn> = {
  'blockColors.isBlockColorsLine': (line: string) => blockColors.BLOCK_COLORS_LINE_REGEX.test(line),
  'blockColors.isTableCellColorsLine': (line: string) =>
    blockColors.TABLE_CELL_COLORS_LINE_REGEX.test(line),
  'blockColors.hasNonDefaultColors': (props: blockColors.BlockColors) =>
    blockColors.hasNonDefaultColors(props),
  'blockColors.serializeBlockColorsMarker': (props: blockColors.BlockColors) =>
    blockColors.serializeBlockColorsMarker(props),
  'blockColors.parseBlockColorsMarker': (line: string) => blockColors.parseBlockColorsMarker(line),
  'blockColors.extractTableCellColors': (content: unknown) =>
    blockColors.extractTableCellColors(content),
  'blockColors.serializeTableCellColorsMarker': (colors: blockColors.TableCellColors) =>
    blockColors.serializeTableCellColorsMarker(colors),
  'blockColors.parseTableCellColorsMarker': (line: string) =>
    blockColors.parseTableCellColorsMarker(line),
  'blockColors.applyTableCellColors': (content: unknown, colors: blockColors.TableCellColors) => {
    blockColors.applyTableCellColors(content, colors)
    return content
  },

  'blockMarkers.isBlockAlignLine': (line: string) => blockMarkers.BLOCK_ALIGN_LINE_REGEX.test(line),
  'blockMarkers.isTableAlignLine': (line: string) => blockMarkers.TABLE_ALIGN_LINE_REGEX.test(line),
  'blockMarkers.isTableLayoutLine': (line: string) =>
    blockMarkers.TABLE_LAYOUT_LINE_REGEX.test(line),
  'blockMarkers.serializeBlockAlignMarker': (props: { textAlignment?: unknown }) =>
    blockMarkers.serializeBlockAlignMarker(props),
  'blockMarkers.parseBlockAlignMarker': (line: string) => blockMarkers.parseBlockAlignMarker(line),
  'blockMarkers.extractTableCellAlignments': (content: unknown) =>
    blockMarkers.extractTableCellAlignments(content),
  'blockMarkers.serializeTableCellAlignmentsMarker': (a: blockMarkers.TableCellAlignments) =>
    blockMarkers.serializeTableCellAlignmentsMarker(a),
  'blockMarkers.parseTableCellAlignmentsMarker': (line: string) =>
    blockMarkers.parseTableCellAlignmentsMarker(line),
  'blockMarkers.applyTableCellAlignments': (
    content: unknown,
    alignments: blockMarkers.TableCellAlignments
  ) => {
    blockMarkers.applyTableCellAlignments(content, alignments)
    return content
  },
  'blockMarkers.extractTableLayout': (content: unknown) => blockMarkers.extractTableLayout(content),
  'blockMarkers.serializeTableLayoutMarker': (layout: blockMarkers.TableLayout) =>
    blockMarkers.serializeTableLayoutMarker(layout),
  'blockMarkers.parseTableLayoutMarker': (line: string) =>
    blockMarkers.parseTableLayoutMarker(line),
  'blockMarkers.applyTableLayout': (content: unknown, layout: blockMarkers.TableLayout) => {
    blockMarkers.applyTableLayout(content, layout)
    return content
  },
  'blockMarkers.sidecarMarkerLines': (block: Block) => blockMarkers.sidecarMarkerLines(block),
  'blockMarkers.parseSidecarMarkerLine': (line: string, block: Block) => {
    const patch = blockMarkers.parseSidecarMarkerLine(line)
    if (!patch) return null
    patch(block)
    return block
  },

  'linkCard.isLinkCardLine': (line: string) => linkCard.LINK_CARD_LINE_REGEX.test(line),
  'linkCard.serializeLinkCardMarker': (block: linkCard.LinkCardBlock) =>
    linkCard.serializeLinkCardMarker(block),
  'linkCard.parseLinkCardMarker': (line: string) => linkCard.parseLinkCardMarker(line),
  'linkCard.applyLinkCard': (
    block: linkCard.LinkCardBlock,
    display: Parameters<typeof linkCard.applyLinkCard>[1]
  ) => {
    linkCard.applyLinkCard(block, display)
    return block
  },

  'inlineColors.extractInlineColorRuns': (blocks: Blocks) => {
    const { blocks: wrapped, replacements } = inlineColors.extractInlineColorRuns(blocks)
    return { blocks: wrapped, replacements: [...replacements.entries()] }
  },
  'inlineColors.restoreInlineColorTokens': (markdown: string, pairs: [string, string][]) =>
    inlineColors.restoreInlineColorTokens(markdown, new Map(pairs)),
  'inlineColors.maskInlineColorSpans': (markdown: string) =>
    inlineColors.maskInlineColorSpans(markdown),
  'inlineColors.applyInlineColorTokens': (blocks: Blocks, spans: inlineColors.MaskedColorSpan[]) =>
    inlineColors.applyInlineColorTokens(blocks, spans),
  'inlineColors.stripInlineStyleSpanTags': (markdown: string) =>
    inlineColors.stripInlineStyleSpanTags(markdown),

  'plainCheckbox.hasPlainCheckboxMarker': (text: string) =>
    plainCheckbox.hasPlainCheckboxMarker(text),
  'plainCheckbox.normalizePlainCheckboxes': (blocks: PlainBlocks) =>
    plainCheckbox.normalizePlainCheckboxes(blocks),
  'plainCheckbox.withPlainCheckboxMarkers': (blocks: PlainBlocks) =>
    plainCheckbox.withPlainCheckboxMarkers(blocks),

  'taskBlock.serializeTaskBlock': (props: taskBlock.TaskBlockProps) =>
    taskBlock.serializeTaskBlock(props),
  'taskBlock.capTaskTreeDepth': (block: taskBlock.TaskNormalizableBlock) =>
    taskBlock.capTaskTreeDepth(block),
  'taskBlock.serializeTaskBlockTree': (block: taskBlock.TaskNormalizableBlock) =>
    taskBlock.serializeTaskBlockTree(block),
  'taskBlock.parseTaskBlockSuffix': (text: string) => taskBlock.parseTaskBlockSuffix(text),
  'taskBlock.scanTaskCheckboxStates': (markdown: string) => [
    ...taskBlock.scanTaskCheckboxStates(markdown).entries()
  ],
  'taskBlock.stripTaskBlockSuffixes': (markdown: string) =>
    taskBlock.stripTaskBlockSuffixes(markdown),
  'taskBlock.extractInlineText': (content: unknown) => taskBlock.extractInlineText(content),
  'taskBlock.normalizeTaskBlocks': (blocks: TaskBlocks, source: string | null) =>
    taskBlock.normalizeTaskBlocks(blocks, source),

  'obsidianTasks.hasObsidianTaskFields': (text: string) => obsidian.hasObsidianTaskFields(text),
  'obsidianTasks.parseObsidianTaskFields': (text: string) => obsidian.parseObsidianTaskFields(text),
  'obsidianTasks.parseObsidianTaskLine': (line: string) => obsidian.parseObsidianTaskLine(line),
  'obsidianTasks.obsidianTaskImportBlocker': (text: string) =>
    obsidian.obsidianTaskImportBlocker(text),

  ...MD_FNS
}
