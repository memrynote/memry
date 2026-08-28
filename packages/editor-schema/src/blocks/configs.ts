/**
 * Block configs — type + propSchema + content, no presentation.
 *
 * A block's propSchema is its (de)serialization contract: the renderer's React
 * spec and the main process's headless spec have to agree exactly or
 * `yXmlFragmentToBlocks` mis-parses the props on one side. This used to be a
 * hand-copied duplicate carrying a comment asking humans to keep the two in
 * step; one object shared by both processes is what makes drift impossible.
 *
 * Presentation stays with each process — main has no React, and rendering is
 * never what reaches the vault file.
 */

import { defaultProps } from '@blocknote/core'
import { CALLOUT_TYPE_VALUES } from './markdown'

export const taskBlockConfig = {
  type: 'taskBlock' as const,
  propSchema: {
    taskId: { default: '' },
    title: { default: '' },
    checked: { default: false },
    parentTaskId: { default: '' }
  },
  content: 'none' as const
}

export const calloutConfig = {
  type: 'callout' as const,
  propSchema: {
    textAlignment: defaultProps.textAlignment,
    textColor: defaultProps.textColor,
    type: {
      default: 'info' as const,
      values: CALLOUT_TYPE_VALUES
    }
  },
  content: 'inline' as const
}

/**
 * `file` shadows a BlockNote DEFAULT block of the same name, and the two have
 * nothing in common but the name: BlockNote's carries caption/showPreview/
 * previewWidth, Memry's carries the attachment's size/mimeType plus the PDF
 * embed's width/height/align. Registering this config is what stops the main
 * process from parsing a Memry file block against BlockNote's propSchema and
 * dropping every prop the default does not declare.
 */
export const fileBlockConfig = {
  type: 'file' as const,
  propSchema: {
    url: { default: '' },
    name: { default: '' },
    size: { default: 0 },
    mimeType: { default: '' },
    width: { default: 0 },
    height: { default: 0 },
    align: { default: 'left' as const, values: ['left', 'center', 'right'] as const }
  },
  content: 'none' as const
}

export const youtubeEmbedConfig = {
  type: 'youtubeEmbed' as const,
  propSchema: {
    videoId: { default: '' },
    videoUrl: { default: '' }
  },
  content: 'none' as const
}

export const bookmarkConfig = {
  type: 'bookmark' as const,
  propSchema: {
    url: { default: '' },
    domain: { default: '' },
    title: { default: '' },
    description: { default: '' },
    image: { default: '' },
    favicon: { default: '' },
    siteName: { default: '' }
  },
  content: 'none' as const
}

/**
 * `toggleListItem` shadows a BlockNote DEFAULT block, and the only difference is
 * `open`. BlockNote keeps a toggle's fold in `window.localStorage` under the
 * block's id, which is per-device and keyed by an id that is minted fresh on
 * every markdown parse — so the fold survived neither a re-open nor a sync
 * (#1847). A prop puts it in the document, where the rest of the block already
 * lives. It defaults to `false` because that is what BlockNote does when the
 * localStorage key is absent, and because a collapsed toggle must keep writing
 * the bytes every vault already holds.
 */
export const toggleListItemConfig = {
  type: 'toggleListItem' as const,
  propSchema: { ...defaultProps, open: { default: false } },
  content: 'inline' as const
}

/** Node names of every custom block spec. The parity gate (#1433) will read this. */
export const MEMRY_BLOCK_TYPES = [
  'taskBlock',
  'callout',
  'file',
  'youtubeEmbed',
  'bookmark',
  'toggleListItem'
] as const
