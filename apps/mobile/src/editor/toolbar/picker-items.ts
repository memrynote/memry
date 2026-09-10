import {
  HEADING_LEVELS,
  type ConvertibleBlock,
  type InsertBlockAction,
  type TableAction
} from '@memry/contracts/webview-bridge'

export type GlyphStyle = 'serif' | 'mono'

export interface PickerVisual {
  label: string
  glyph: string
  glyphStyle?: GlyphStyle
}

export interface BlockPickerItem extends PickerVisual {
  action: InsertBlockAction
}

export interface BlockPickerGroup {
  label: string
  items: readonly BlockPickerItem[]
}

export interface TablePickerItem extends PickerVisual {
  action: TableAction
  /** Locked out when the table carries a merged cell the phone cannot re-index. */
  structural?: boolean
}

export interface TablePickerGroup {
  label: string
  items: readonly TablePickerItem[]
}

export interface TurnIntoItem extends PickerVisual {
  block: ConvertibleBlock
}

export const BLOCK_PICKER_GROUPS: readonly BlockPickerGroup[] = [
  {
    label: 'Basic blocks',
    items: [
      {
        label: 'Text',
        glyph: 'T',
        glyphStyle: 'serif',
        action: { kind: 'convertible', block: { kind: 'paragraph' } }
      },
      ...HEADING_LEVELS.map((level): BlockPickerItem => ({
        label: `Heading ${level}`,
        glyph: `H${level}`,
        glyphStyle: 'serif',
        action: { kind: 'convertible', block: { kind: 'heading', level } }
      })),
      {
        label: 'Bulleted list',
        glyph: '•',
        action: { kind: 'convertible', block: { kind: 'bulletListItem' } }
      },
      {
        label: 'Numbered list',
        glyph: '1.',
        action: { kind: 'convertible', block: { kind: 'numberedListItem' } }
      },
      {
        label: 'To-do list',
        glyph: '✓',
        action: { kind: 'convertible', block: { kind: 'checkListItem' } }
      },
      {
        label: 'Toggle list',
        glyph: '▸',
        action: { kind: 'convertible', block: { kind: 'toggleListItem' } }
      },
      {
        label: 'Quote',
        glyph: '“',
        glyphStyle: 'serif',
        action: { kind: 'convertible', block: { kind: 'quote' } }
      },
      {
        label: 'Code',
        glyph: '</>',
        glyphStyle: 'mono',
        action: { kind: 'convertible', block: { kind: 'codeBlock' } }
      },
      { label: 'Callout', glyph: '!', action: { kind: 'convertible', block: { kind: 'callout' } } },
      { label: 'Divider', glyph: '—', action: { kind: 'divider' } }
    ]
  },
  {
    label: 'Media',
    items: [
      { label: 'Image', glyph: '▧', action: { kind: 'attachment', blockType: 'image' } },
      { label: 'File', glyph: '⌑', action: { kind: 'attachment', blockType: 'file' } }
    ]
  },
  {
    label: 'Advanced',
    items: [
      { label: 'Table', glyph: '▦', action: { kind: 'table' } },
      { label: 'Link to note', glyph: '[[', glyphStyle: 'mono', action: { kind: 'wikiLink' } }
    ]
  }
]

/**
 * The basic blocks, carrying the block itself rather than an insert action.
 *
 * The turn-into panel can only offer conversions, so the non-convertible rows
 * are dropped here once instead of being re-checked on every render.
 */
export const TURN_INTO_ITEMS: readonly TurnIntoItem[] = BLOCK_PICKER_GROUPS[0].items.flatMap(
  (item): TurnIntoItem[] =>
    item.action.kind === 'convertible'
      ? [
          {
            label: item.label,
            glyph: item.glyph,
            glyphStyle: item.glyphStyle,
            block: item.action.block
          }
        ]
      : []
)

/**
 * The table panel, which is mobile's whole answer to desktop's border nubs.
 *
 * Every row is an ordinary picker card, so each one is a 64pt target rather
 * than a hairline on a cell border, and the operation applies to the cell the
 * caret is already in — there is nothing to aim at.
 */
export const TABLE_PICKER_GROUPS: readonly TablePickerGroup[] = [
  {
    label: 'Row',
    items: [
      {
        label: 'Insert above',
        glyph: '⤒',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-row', side: 'above' } }
      },
      {
        label: 'Insert below',
        glyph: '⤓',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-row', side: 'below' } }
      },
      {
        label: 'Move up',
        glyph: '↑',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-row', direction: 'up' } }
      },
      {
        label: 'Move down',
        glyph: '↓',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-row', direction: 'down' } }
      },
      {
        label: 'Delete row',
        glyph: '⊖',
        structural: true,
        action: { kind: 'structure', op: { kind: 'delete-row' } }
      }
    ]
  },
  {
    label: 'Column',
    items: [
      {
        label: 'Insert before',
        glyph: '⇤',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-column', side: 'before' } }
      },
      {
        label: 'Insert after',
        glyph: '⇥',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-column', side: 'after' } }
      },
      {
        label: 'Move start',
        glyph: '↞',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-column', direction: 'start' } }
      },
      {
        label: 'Move end',
        glyph: '↠',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-column', direction: 'end' } }
      },
      {
        label: 'Delete column',
        glyph: '⊖',
        structural: true,
        action: { kind: 'structure', op: { kind: 'delete-column' } }
      }
    ]
  },
  {
    label: 'Cell',
    items: [
      { label: 'Image', glyph: '▧', action: { kind: 'inline-image' } },
      { label: 'Checkbox', glyph: '☐', action: { kind: 'inline-checkbox' } }
    ]
  },
  {
    label: 'Table',
    items: [{ label: 'Delete table', glyph: '✕', action: { kind: 'delete-table' } }]
  }
]
